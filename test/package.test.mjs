/**
 * 打包契约测试：package.json 必须与 dsh 的装配约定一致。
 * 这些字段一旦写错，安装能成功但插件“静默不生效”，所以用测试钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

/** 读仓库根下的文件。 */
async function readRoot(name) {
  return readFile(new URL(name, root), 'utf8')
}

/** 文件是否存在（且是普通文件）。 */
async function exists(name) {
  try {
    const info = await stat(new URL(name, root))
    return info.isFile()
  } catch {
    return false
  }
}

test('package.json：bundle 装配字段齐全且指向真实文件', async () => {
  const pkg = JSON.parse(await readRoot('package.json'))
  assert.equal(pkg.name, 'dsh-plugin-management')
  assert.equal(pkg.type, 'module')
  assert.equal(typeof pkg.version, 'string')
  // Loader 用 main 解析 host half
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(await exists(pkg.main), 'main 指向的文件必须存在')
  // dsh.bundle.patch 决定它算不算插件层（dsh plugin add 靠这个自动进 bundles）
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(await exists('cordis.patch.yml'), 'cordis.patch.yml 必须存在')
  // dsh.client + exports["./client"] 是 Web 面板被发现的唯一途径
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(await exists('lib/client.js'), 'client bundle 必须存在')
  assert.ok(await exists('lib/index.js'))
})

test('cordis.patch.yml：插入行的 id/name 与包名一致', async () => {
  const pkg = JSON.parse(await readRoot('package.json'))
  const patch = await readRoot('cordis.patch.yml')
  assert.match(patch, /- insert:/)
  assert.match(patch, new RegExp(`id: ${pkg.name}\\b`))
  assert.match(patch, new RegExp(`name: ${pkg.name}\\b`))
  // 不许出现第二个顶层值（YAML 只允许单一顶层值：[] 或 - id: 列表）
  const topLevel = patch
    .split('\n')
    .filter((line) => /^[^\s#-]/.test(line) && line.trim() !== '')
  assert.deepEqual(topLevel, [], `cordis.patch.yml 顶层只能有列表项，收到: ${topLevel.join(' | ')}`)
})

test('client bundle：必须是 __ModuleLoader__.load 包装且声明 inject', async () => {
  const source = await readRoot('lib/client.js')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id: 'dsh-plugin-management'/)
  assert.match(source, /exports\.inject\s*=/)
  assert.match(source, /exports\.apply\s*=/)
  // 不得出现构建期语法残留
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /^\s*export\s/m)
})

test('README / CHANGELOG / LICENSE 存在', async () => {
  for (const file of ['README.md', 'README.en.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(await exists(file), `${file} 必须存在`)
  }
})
