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
 * 命令的沙箱策略。
 *
 * 为什么必须显式传：不传时执行器按 dsh 自己的可写根（进程 cwd）跑，而
 * `pnpm update` 会写 pnpm store（如 `D:\.pnpm-store\v11` / `~/.local/share/pnpm/store`），
 * 那不在任何 profile 目录里 —— 于是**即使沙箱健康，一键更新也会在写 store 时 Access is denied**。
 * 这里以命令的 workdir 作为 workspaceRoot 并声明 danger-full-access，
 * 让「装包」这条固有需要跨目录写的操作能真正跑完。
 *
 * 想收紧：行配置 `config.sandboxMode` 可改成 read-only / workspace-write
 * （代价是更新会在写 store 时被拒，属于有意的取舍）。
 */
export const DEFAULT_SANDBOX_MODE = 'danger-full-access'
/** 合法的沙箱模式（与 dsh 的 SandboxMode 一致）。 */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * 归一化沙箱模式，非法值退回默认。
 * @param {unknown} value config.sandboxMode
 * @returns {'read-only' | 'workspace-write' | 'danger-full-access'} 可用模式
 */
export function normalizeSandboxMode(value) {
  return typeof value === 'string' && SANDBOX_MODES.has(value) ? value : DEFAULT_SANDBOX_MODE
}

/**
 * 把任意异常压成一行可读文本（带上 code，便于分辨 SANDBOX_UNAVAILABLE 这类）。
 * @param {unknown} error 异常
 * @returns {string} 一行描述
 */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${code}${message}`.split('\n')[0].slice(0, 300)
}

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
 * 建一个 runner：优先用 dsh 的 shell 服务，不可用时退 child_process。
 *
 * 「不可用」有两种，都走同一条不受限兜底（与既有信任模型一致）：
 *   1. shell 服务没挂载（组合里没有 shell 行）；
 *   2. shell 服务在，但**执行器/沙箱后端起不来**（实测表现为 `SANDBOX_UNAVAILABLE`）。
 *      shell 契约保证 `run()` 只在基础设施故障时 reject（非零退出是正常 resolve），
 *      所以任何 reject 都按「执行器不可用」处理，并把原因写进日志——不静默吞掉。
 *
 * 注意：**沙箱明确拒绝（denied）不会走兜底** —— 那是策略决定，不是故障，
 * 兜底绕过它就等于让 `config.sandboxMode` 形同虚设。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {{ sandboxMode?: string, warn?: (message: string) => void }} [options] 选项
 * @returns {(command: string, options?: { workdir?: string, timeoutMs?: number }) => Promise<RunResult>}
 *   执行函数
 */
export function createRunner(ctx, options = {}) {
  const sandboxMode = normalizeSandboxMode(options.sandboxMode)
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  return async function run(command, runOptions = {}) {
    const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 每次现取：shell 行可能比本插件晚挂载（cordis 允许后到的服务）。
    const shell = ctx.get('shell')
    if (shell === undefined || typeof shell.resolve !== 'function') {
      return runViaChildProcess(command, { workdir: runOptions.workdir, timeoutMs })
    }
    const request = { command, timeoutMs, stdoutMaxBytes: MAX_OUTPUT_BYTES }
    if (runOptions.workdir !== undefined) {
      request.workdir = runOptions.workdir
      // 显式执行策略：可写根 = 命令的 workdir（见 DEFAULT_SANDBOX_MODE 的说明）
      request.sandboxPolicy = { mode: sandboxMode, workspaceRoot: runOptions.workdir }
    }
    try {
      const result = await shell.run(shell.resolve(request))
      return {
        exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
        stdout: typeof result?.stdout?.text === 'string' ? result.stdout.text : '',
        stderr: typeof result?.stderr?.text === 'string' ? result.stderr.text : '',
        timedOut: result?.timedOut === true,
      }
    } catch (error) {
      warn(
        `shell executor unavailable (${describeError(error)}); falling back to child_process for: ${command}`,
      )
      return runViaChildProcess(command, { workdir: runOptions.workdir, timeoutMs })
    }
  }
}
