/**
 * dsh-plugin-management —— 命令执行（一条窄缝，方便替换与单测）。
 *
 * 首选 dsh 的 shell 服务（ctx.shell）：它自带执行器、超时、输出上限与沙箱策略；
 * 缺失时退化为本进程的 child_process（同样是“命令字符串 → cwd + 输出”语义），
 * 保证插件在没有 shell 行的组合里仍然可用。
 *
 * @module dsh-plugin-management/exec
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 默认超时（毫秒）；pnpm 在慢网络下确实会久，但必须有个上限。 */
export const DEFAULT_TIMEOUT_MS = 60_000
/** 单条命令的输出上限（字节），超出由执行器截断。 */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
/** 兜底 child_process 的缓冲上限，比 MAX_OUTPUT_BYTES 稍大以免刚好卡边界。 */
const MAX_BUFFER_BYTES = MAX_OUTPUT_BYTES + 64 * 1024

/**
 * @typedef {object} RunResult
 * @property {number | null} exitCode 退出码（超时/被杀为 null）
 * @property {string} stdout 标准输出（可能被截断）
 * @property {string} stderr 标准错误（可能被截断）
 * @property {boolean} timedOut 是否超时被杀
 */

/**
 * 用 child_process 跑一条命令（shell 服务缺失时的兜底）。
 * Windows 走 cmd.exe，其它平台走 /bin/sh——与 dsh 的 PowerShell/bash 执行器同语义：
 * 命令字符串由平台 shell 解释，cwd 由调用方给定。
 * @param {string} command 命令字符串
 * @param {{ workdir?: string, timeoutMs?: number }} options 选项
 * @returns {Promise<RunResult>} 执行结果（不抛）
 */
async function runViaChildProcess(command, options) {
  const isWindows = process.platform === 'win32'
  const file = isWindows ? 'cmd.exe' : '/bin/sh'
  const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command]
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.workdir,
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    })
    return { exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: false }
  } catch (error) {
    const killed = error?.killed === true || error?.signal === 'SIGTERM'
    return {
      exitCode: typeof error?.code === 'number' ? error.code : killed ? null : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
      timedOut: killed,
    }
  }
}

/**
 * 建一个 runner：优先用 dsh 的 shell 服务，缺失时退 child_process。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @returns {(command: string, options?: { workdir?: string, timeoutMs?: number }) => Promise<RunResult>}
 *   执行函数
 */
export function createRunner(ctx) {
  return async function run(command, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 每次现取：shell 行可能比本插件晚挂载（cordis 允许后到的服务）。
    const shell = ctx.get('shell')
    if (shell === undefined || typeof shell.resolve !== 'function') {
      return runViaChildProcess(command, { workdir: options.workdir, timeoutMs })
    }
    const request = { command, timeoutMs, stdoutMaxBytes: MAX_OUTPUT_BYTES }
    if (options.workdir !== undefined) request.workdir = options.workdir
    const result = await shell.run(shell.resolve(request))
    return {
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
      stdout: typeof result?.stdout?.text === 'string' ? result.stdout.text : '',
      stderr: typeof result?.stderr?.text === 'string' ? result.stderr.text : '',
      timedOut: result?.timedOut === true,
    }
  }
}
