/**
 * exec.js 单测：执行策略必须显式带上（可写根），执行器/沙箱不可用要能兜底。
 * 这两条对应两个真实故障：
 *   1. 不传 sandboxPolicy 时，pnpm 写 store（不在 profile 目录里）会被拒 → 一键更新必失败；
 *   2. 沙箱后端起不来（SANDBOX_UNAVAILABLE）时若直接抛，整条链路就崩了，
 *      而这里本来就有一条不受限的 child_process 兜底。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SANDBOX_MODE, createRunner, normalizeSandboxMode } from '../lib/exec.js'

test('normalizeSandboxMode：只放行 dsh 的三种模式，其它退回默认', () => {
  assert.equal(normalizeSandboxMode('read-only'), 'read-only')
  assert.equal(normalizeSandboxMode('workspace-write'), 'workspace-write')
  assert.equal(normalizeSandboxMode('danger-full-access'), 'danger-full-access')
  assert.equal(normalizeSandboxMode('nope'), DEFAULT_SANDBOX_MODE)
  assert.equal(normalizeSandboxMode(undefined), DEFAULT_SANDBOX_MODE)
  assert.equal(DEFAULT_SANDBOX_MODE, 'danger-full-access')
})

test('createRunner：显式把 { mode, workspaceRoot } 交给 shell.resolve', async () => {
  const seen = []
  const shell = {
    resolve: (request) => {
      seen.push(request)
      return request
    },
    run: async () => ({ exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' }, timedOut: false }),
  }
  const run = createRunner(
    { get: (name) => (name === 'shell' ? shell : undefined) },
    { sandboxMode: 'danger-full-access' },
  )
  const result = await run('pnpm outdated --format json', { workdir: 'C:/home/profiles/web' })
  assert.equal(result.stdout, 'ok')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(seen[0].sandboxPolicy, {
    mode: 'danger-full-access',
    workspaceRoot: 'C:/home/profiles/web',
  })
  assert.equal(seen[0].workdir, 'C:/home/profiles/web')
  assert.equal(seen[0].timeoutMs > 0, true)
})

test('createRunner：沙箱后端起不来时走 child_process 兜底，并留下告警', async () => {
  const warnings = []
  const failure = new Error('sandbox backend failed to start')
  failure.code = 'SANDBOX_UNAVAILABLE'
  const shell = {
    resolve: (request) => request,
    run: async () => {
      throw failure
    },
  }
  const run = createRunner(
    { get: () => shell },
    { warn: (message) => warnings.push(message) },
  )
  const result = await run('echo dsh-pm-fallback', { workdir: process.cwd() })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /dsh-pm-fallback/)
  assert.equal(warnings.length, 1, '兜底必须留痕，不能静默')
  assert.match(warnings[0], /SANDBOX_UNAVAILABLE/)
  assert.match(warnings[0], /falling back to child_process/)
})

test('createRunner：shell 服务缺失时直接走 child_process（无告警）', async () => {
  const warnings = []
  const run = createRunner(
    { get: () => undefined },
    { warn: (message) => warnings.push(message) },
  )
  const result = await run('echo dsh-pm-fallback')
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /dsh-pm-fallback/)
  assert.deepEqual(warnings, [])
})

test('createRunner：没有 workdir 时不塞 sandboxPolicy（workspaceRoot 必填，不能瞎猜）', async () => {
  const seen = []
  const shell = {
    resolve: (request) => {
      seen.push(request)
      return request
    },
    run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, timedOut: false }),
  }
  const run = createRunner({ get: () => shell })
  await run('node -v')
  assert.equal(seen[0].sandboxPolicy, undefined)
})

test('createRunner：命令非零退出是正常结果，不触发兜底', async () => {
  const seen = []
  const shell = {
    resolve: (request) => {
      seen.push(request)
      return request
    },
    run: async () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: 'ERR_PNPM_X' }, timedOut: false }),
  }
  const run = createRunner({ get: () => shell })
  const result = await run('pnpm outdated --format json', { workdir: process.cwd() })
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderr, 'ERR_PNPM_X')
  assert.equal(seen.length, 1, '不应重试/兜底')
})
