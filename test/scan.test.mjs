/**
 * scan.js 单测：用临时目录造一个假的 $DSH_HOME，覆盖 profile 发现与依赖分类。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isOfficialName,
  isSafePackageName,
  isSafeProfileName,
  resolveDshHome,
  scanProfile,
  scanProfiles,
} from '../lib/scan.js'

/** 造一个假 dsh home：web（有依赖）/ empty（无依赖）/ broken（无 package.json）/ node_modules（必须跳过）。 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pm-scan-'))
  const profiles = join(home, 'profiles')
  const web = join(profiles, 'web')
  const externalDir = join(web, 'node_modules', '@mars-sea', 'dsh-commandcode-provider')
  await mkdir(externalDir, { recursive: true })
  await writeFile(
    join(externalDir, 'package.json'),
    JSON.stringify({
      name: '@mars-sea/dsh-commandcode-provider',
      version: '0.11.5',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  await writeFile(
    join(web, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh-base': '^0.1.5',
        '@mars-sea/dsh-commandcode-provider': '^0.11.5',
        'dsh-plain-lib': '^1.0.0',
        'dsh-local-dev': 'link:D:/dev/dsh-local-dev',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@mars-sea/dsh-commandcode-provider', 'dsh-local-dev'],
        },
      },
    }),
  )
  const empty = join(profiles, 'empty')
  await mkdir(empty, { recursive: true })
  await writeFile(join(empty, 'package.json'), JSON.stringify({ name: 'dsh-profile-empty', dsh: { profile: { bundles: [] } } }))
  await mkdir(join(profiles, 'broken'), { recursive: true })
  await mkdir(join(profiles, 'node_modules'), { recursive: true })
  return home
}

test('scanProfiles 只收有 package.json 的 profile，并跳过 node_modules', async () => {
  const home = await makeHome()
  try {
    const result = await scanProfiles(home)
    assert.equal(result.home, home)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(
      result.profiles.map((profile) => profile.name),
      ['empty', 'web'],
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('scanProfile 分类依赖：官方/外部/插件层/本地链接/已装版本', async () => {
  const home = await makeHome()
  try {
    const result = await scanProfiles(home)
    const web = result.profiles.find((profile) => profile.name === 'web')
    assert.ok(web)
    assert.deepEqual(web.bundles, ['@deepseek-ai/dsh-base', '@mars-sea/dsh-commandcode-provider', 'dsh-local-dev'])
    const byName = Object.fromEntries(web.items.map((item) => [item.name, item]))
    assert.equal(byName['@deepseek-ai/dsh-base'].layer, true)
    assert.equal(byName['@mars-sea/dsh-commandcode-provider'].installed, '0.11.5')
    assert.equal(byName['@mars-sea/dsh-commandcode-provider'].declaresBundle, true)
    assert.equal(byName['@mars-sea/dsh-commandcode-provider'].local, false)
    // 装了但不是插件层：dependencies 有、bundles 没有
    assert.equal(byName['dsh-plain-lib'].layer, false)
    assert.equal(byName['dsh-plain-lib'].installed, null)
    // 本地链接：不可从 registry 更新
    assert.equal(byName['dsh-local-dev'].local, true)
    assert.equal(byName['dsh-local-dev'].layer, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('scanProfile 对不存在/坏 JSON 的目录返回 null 而不抛', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pm-bad-'))
  try {
    assert.equal(await scanProfile(join(home, 'nope'), 'nope'), null)
    await mkdir(join(home, 'bad'), { recursive: true })
    await writeFile(join(home, 'bad', 'package.json'), '{ not json')
    assert.equal(await scanProfile(join(home, 'bad'), 'bad'), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('scanProfiles 对读不到的 home 记 errors 而不是抛', async () => {
  const result = await scanProfiles(join(tmpdir(), 'dsh-pm-does-not-exist-9527'))
  assert.deepEqual(result.profiles, [])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /^profiles: /)
})

test('resolveDshHome 与 dsh-home-paths 的优先级一致', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:/custom' }), 'D:/custom')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), resolveDshHome({}))
  assert.match(resolveDshHome({}), /\.dsh$/)
})

test('名称守卫挡得住路径穿越与命令注入', () => {
  assert.equal(isOfficialName('@deepseek-ai/dsh-base'), true)
  assert.equal(isOfficialName('dsh-tinyfish-search'), false)
  assert.equal(isProfile('web'), true)
  assert.equal(isProfile('..'), false)
  assert.equal(isProfile('a/b'), false)
  assert.equal(isProfile('node_modules'), false)
  assert.equal(isProfile('web; rm -rf /'), false)
  assert.equal(isPackage('@mars-sea/dsh-commandcode-provider'), true)
  assert.equal(isPackage('dsh-tinyfish-search'), true)
  assert.equal(isPackage('dsh-a; rm -rf /'), false)
  assert.equal(isPackage('dsh-a && echo pwned'), false)
  assert.equal(isPackage(''), false)
})

/** 局部别名，读起来更短。 */
function isProfile(value) {
  return isSafeProfileName(value)
}
/** 局部别名，读起来更短。 */
function isPackage(value) {
  return isSafePackageName(value)
}
