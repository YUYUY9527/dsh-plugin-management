/**
 * inventory.js 单测：注入假 run / 假 scan，覆盖清单、版本检查、更新命令与兜底。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRow, createInventory, installCommandFor } from '../lib/inventory.js'

/** 造一份扫描结果快照。 */
function snapshot() {
  return {
    home: 'C:/home',
    errors: [],
    profiles: [
      {
        name: 'web',
        dir: 'C:/home/profiles/web',
        bundles: ['@deepseek-ai/dsh-base', 'dsh-a', 'dsh-b', 'dsh-link'],
        items: [
          { name: '@deepseek-ai/dsh-base', spec: '^0.1.5', installed: '0.1.5', declaresBundle: true, layer: true, local: false },
          { name: 'dsh-a', spec: '^1.0.0', installed: '1.0.0', declaresBundle: true, layer: true, local: false },
          { name: 'dsh-b', spec: '^2.0.0', installed: '2.0.0', declaresBundle: true, layer: true, local: false },
          { name: 'dsh-link', spec: 'link:D:/dev/dsh-link', installed: '0.0.1', declaresBundle: true, layer: true, local: true },
        ],
      },
      { name: 'empty', dir: 'C:/home/profiles/empty', bundles: [], items: [] },
    ],
  }
}

/** 记录调用的假 runner。 */
function makeRun(handler) {
  const calls = []
  const run = async (command, options) => {
    calls.push({ command, options })
    return handler(command, options, calls.length)
  }
  return { run, calls }
}

test('inventory（不查版本）：只读扫描结果，官方包不进列表', async () => {
  const { run, calls } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const data = await service.inventory()
  assert.equal(data.profile, 'web')
  assert.equal(data.exists, true)
  assert.equal(data.profileDir, 'C:/home/profiles/web')
  assert.equal(data.bundleLayers, 4)
  assert.equal(data.externalLayers, 3)
  assert.equal(data.checked, false)
  assert.deepEqual(
    data.plugins.map((row) => row.name),
    ['dsh-a', 'dsh-b', 'dsh-link'],
  )
  assert.equal(calls.length, 0, '不查版本时不该跑任何命令')
})

test('inventory(check)：合并 pnpm outdated 结果，区分 within-range 与跨大版本', async () => {
  const outdated = JSON.stringify({
    'dsh-a': { current: '1.0.0', latest: '1.2.0', wanted: '1.1.0', isDeprecated: false },
    'dsh-b': { current: '2.0.0', latest: '3.0.0', wanted: '2.0.0', isDeprecated: true },
  })
  const { run, calls } = makeRun(() => ({ exitCode: 1, stdout: outdated, stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const data = await service.inventory({ check: true })
  assert.equal(data.checked, true)
  assert.equal(data.checkError, null)
  assert.equal(calls[0].command, 'pnpm outdated --format json')
  assert.equal(calls[0].options.workdir, 'C:/home/profiles/web')
  const a = data.plugins.find((row) => row.name === 'dsh-a')
  assert.equal(a.latest, '1.2.0')
  assert.equal(a.inRange, true, 'wanted 高于已装 → 可以直接 update')
  assert.equal(a.major, true, 'latest 高于 wanted → 还有跨大版本')
  assert.equal(a.outdated, true)
  const b = data.plugins.find((row) => row.name === 'dsh-b')
  assert.equal(b.inRange, false, 'wanted == current → 只能 --latest')
  assert.equal(b.major, true)
  assert.equal(b.deprecated, true)
  const link = data.plugins.find((row) => row.name === 'dsh-link')
  assert.equal(link.updatable, false, '本地链接不参与更新')
  assert.equal(link.outdated, false)
})

test('inventory(check)：检查失败时保留清单并给出 checkError', async () => {
  const { run } = makeRun(() => ({ exitCode: 1, stdout: '', stderr: 'ERR_PNPM_NO_IMPORTER_MANIFEST\nboom', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const data = await service.inventory({ check: true })
  assert.equal(data.checked, false)
  assert.match(data.checkError, /ERR_PNPM_NO_IMPORTER_MANIFEST/)
  assert.equal(data.plugins.length, 3, '检查失败不影响清单本身')
})

test('inventory(check)：没有过期包时 pnpm 退出码 0 → 视为全部最新', async () => {
  const { run } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const data = await service.inventory({ check: true })
  assert.equal(data.checked, true)
  assert.ok(data.plugins.every((row) => row.outdated === false))
})

test('update：默认全部外部插件，走 dsh plugin 官方转发器', async () => {
  const { run, calls } = makeRun(() => ({ exitCode: 0, stdout: 'Progress: resolved 2\n', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const result = await service.update()
  assert.equal(result.ok, true)
  assert.equal(result.command, 'dsh plugin --profile web update dsh-a dsh-b')
  assert.deepEqual(result.names, ['dsh-a', 'dsh-b'])
  assert.equal(result.restartRequired, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.workdir, 'C:/home/profiles/web')
  assert.match(result.stdout, /resolved 2/)
})

test('update：指定包名 + --latest', async () => {
  const { run, calls } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const result = await service.update({ names: ['dsh-b'], latest: true })
  assert.equal(result.command, 'dsh plugin --profile web update --latest dsh-b')
  assert.deepEqual(result.names, ['dsh-b'])
  assert.equal(calls[0].command, result.command)
})

test('update：dsh 不在 PATH 时回落 pnpm update（cwd 仍是 profile 目录）', async () => {
  const { run, calls } = makeRun((command, _options, index) =>
    index === 1
      ? { exitCode: 1, stdout: '', stderr: "'dsh' is not recognized as an internal or external command", timedOut: false }
      : { exitCode: 0, stdout: 'done', stderr: '', timedOut: false },
  )
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const result = await service.update({ names: ['dsh-a'] })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, 'dsh plugin --profile web update dsh-a')
  assert.equal(calls[1].command, 'pnpm update dsh-a')
  assert.equal(calls[1].options.workdir, 'C:/home/profiles/web')
  assert.equal(result.command, 'pnpm update dsh-a')
})

test('update：没有可更新的外部插件时不跑任何命令', async () => {
  const { run, calls } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const result = await service.update({ profile: 'empty' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.names, [])
  assert.equal(calls.length, 0)
})

test('update：非法包名被过滤掉，不会拼进命令', async () => {
  const { run, calls } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const result = await service.update({ names: ['dsh-a; rm -rf /', 'dsh-a && echo pwned'] })
  assert.deepEqual(result.names, [])
  assert.equal(calls.length, 0)
})

test('update：profile 不存在时抛错（由上层转成 JSON error）', async () => {
  const { run } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => ({ home: 'C:/home', errors: [], profiles: [] }), home: 'C:/home' })
  await assert.rejects(() => service.update({ profile: 'nope' }), /profile not found/)
})

test('buildRow：info 为空表示未检查/最新，不编造版本', () => {
  const item = { name: 'dsh-x', spec: '^1.0.0', installed: '1.0.0', layer: true, local: false, declaresBundle: true }
  const row = buildRow(item, null)
  assert.equal(row.latest, null)
  assert.equal(row.outdated, false)
  assert.equal(row.major, false)
  assert.equal(row.updatable, true)
})

test('磁盘缓存：第二次 inventory 不再重扫（refresh 才重扫）', async () => {
  let scans = 0
  const { run } = makeRun(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const service = createInventory({
    run,
    home: 'C:/home',
    scan: async () => {
      scans += 1
      return snapshot()
    },
  })
  await service.inventory()
  await service.inventory()
  assert.equal(scans, 1)
  await service.inventory({ refresh: true })
  assert.equal(scans, 2)
})

test('installCommand：registry 包钉到最新版，本地链接原样复用 spec', async () => {
  const { run } = makeRun(() => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false }))
  const service = createInventory({ run, scan: async () => snapshot(), home: 'C:/home' })
  const plain = await service.inventory()
  assert.equal(
    plain.plugins.find((row) => row.name === 'dsh-a').installCommand,
    'dsh plugin --profile web add dsh-a',
  )
  assert.equal(
    plain.plugins.find((row) => row.name === 'dsh-link').installCommand,
    'dsh plugin --profile web add link:D:/dev/dsh-link',
  )

  const outdated = JSON.stringify({ 'dsh-a': { current: '1.0.0', latest: '1.2.0', wanted: '1.1.0' } })
  const service2 = createInventory({
    run: makeRun(() => ({ exitCode: 1, stdout: outdated, stderr: '', timedOut: false })).run,
    scan: async () => snapshot(),
    home: 'C:/home',
  })
  const checked = await service2.inventory({ check: true })
  assert.equal(
    checked.plugins.find((row) => row.name === 'dsh-a').installCommand,
    'dsh plugin --profile web add dsh-a@1.2.0',
    '知道最新版就把命令钉到最新版（等价于升级）',
  )
})

test('installCommandFor：git / tarball URL 用原始 spec，registry 用 name@latest，profile 可换', () => {
  const base = { installed: '1.0.0', layer: true, declaresBundle: true, local: false }
  assert.equal(
    installCommandFor({ ...base, name: 'dsh-git', spec: 'github:o/r' }, null, 'web'),
    'dsh plugin --profile web add github:o/r',
  )
  assert.equal(
    installCommandFor({ ...base, name: 'dsh-tgz', spec: 'https://example.com/x.tgz' }, '2.0.0', 'web'),
    'dsh plugin --profile web add https://example.com/x.tgz',
  )
  assert.equal(
    installCommandFor({ ...base, name: 'dsh-a', spec: '^1.0.0' }, '1.2.0', 'tui'),
    'dsh plugin --profile tui add dsh-a@1.2.0',
  )
  assert.equal(
    installCommandFor({ ...base, name: 'dsh-a', spec: '^1.0.0' }, null, 'web'),
    'dsh plugin --profile web add dsh-a',
  )
  assert.equal(
    installCommandFor({ ...base, name: 'local-x', spec: 'file:../x', local: true }, null, 'web'),
    'dsh plugin --profile web add file:../x',
  )
  // profile 缺省时兜底成 web，命令始终可执行
  assert.equal(installCommandFor({ ...base, name: 'dsh-a', spec: '^1.0.0' }, null, undefined), 'dsh plugin --profile web add dsh-a')
})
