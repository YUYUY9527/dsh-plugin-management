/**
 * dsh-plugin-management —— profile 扫描（纯 Node，无 dsh 依赖，可单测）。
 *
 * 数据模型对齐 dsh 自己的 profile 约定（见 @deepseek-ai/dsh-app-boot）：
 *   $DSH_HOME/profiles/<name>/package.json
 *     dependencies          —— pnpm 装进来的依赖（含外部插件包）
 *     dsh.profile.bundles   —— 生效的插件层清单，按顺序装配 cordis.patch.yml
 *
 * 判定规则：
 *   · 外部插件 = dependencies 里**非** @deepseek-ai/ 开头的包
 *   · layer    = 该包同时出现在 dsh.profile.bundles 里（即真的当插件层生效了）
 *   · local    = link:/file:/workspace:/portal: 协议（本地开发链接，无法从 registry 更新）
 *
 * @module dsh-plugin-management/scan
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方包 scope：不属于它的依赖一律视为“外部插件”。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'
/** profile 根目录名（$DSH_HOME/profiles）。 */
export const PROFILES_DIR = 'profiles'
/** 本地路径协议：这些依赖不来自 registry。 */
export const LOCAL_SPEC_RE = /^(link|file|workspace|portal):/i

/**
 * 解析 dsh home。优先级与 @deepseek-ai/dsh-home-paths 一致：
 * 非空的 $DSH_HOME，其次 ~/.dsh。
 * @param {Record<string, string | undefined>} [env] 环境变量（默认 process.env）
 * @returns {string} dsh home 绝对路径
 */
export function resolveDshHome(env = process.env) {
  const value = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return value !== '' ? value : join(homedir(), '.dsh')
}

/**
 * 是否官方包。
 * @param {unknown} name 包名
 * @returns {boolean} 官方 scope 为 true
 */
export function isOfficialName(name) {
  return typeof name === 'string' && name.startsWith(OFFICIAL_SCOPE)
}

/**
 * profile 名是否安全（与 resolveProfileDir 的约束一致，并挡住路径穿越）。
 * @param {unknown} name profile 名
 * @returns {boolean} 可安全拼进路径为 true
 */
export function isSafeProfileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false
  if (name === 'node_modules' || name === '.' || name === '..') return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * 包名是否安全：本插件会把它拼进 shell 命令，必须挡住空格/分号/管道等注入面。
 * 形状 = 可选 scope + 包名，符合 npm 命名规则。
 * @param {unknown} name 包名
 * @returns {boolean} 可安全拼进命令为 true
 */
export function isSafePackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false
  return /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * 读一个 JSON 文件，失败（不存在/坏 JSON/无权限）统一返回 null。
 * @param {string} path 绝对路径
 * @returns {Promise<any | null>} 解析结果或 null
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 扫描单个 profile 目录。
 * @param {string} dir profile 目录绝对路径
 * @param {string} name profile 名
 * @returns {Promise<{ name: string, dir: string, bundles: string[], items: Array<object> } | null>}
 *   没有 package.json（不是 profile）返回 null
 */
export async function scanProfile(dir, name) {
  const manifest = await readJson(join(dir, 'package.json'))
  if (manifest === null || typeof manifest !== 'object') return null
  const profileSection = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh.profile : undefined
  const bundles = Array.isArray(profileSection?.bundles)
    ? profileSection.bundles.filter((value) => typeof value === 'string')
    : []
  const dependencies =
    manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const items = []
  for (const dep of Object.keys(dependencies)) {
    const spec = String(dependencies[dep])
    const pkg = await readJson(join(dir, 'node_modules', dep, 'package.json'))
    items.push({
      name: dep,
      spec,
      installed: typeof pkg?.version === 'string' ? pkg.version : null,
      declaresBundle: typeof pkg?.dsh?.bundle?.patch === 'string',
      layer: bundles.includes(dep),
      local: LOCAL_SPEC_RE.test(spec),
    })
  }
  return { name, dir, bundles, items }
}

/**
 * 扫描 $DSH_HOME/profiles 下的全部 profile。
 * 单个 profile 坏掉不影响整体：读不出来的直接跳过，profiles 目录本身读不到则记进 errors。
 * @param {string} [home] dsh home（默认 resolveDshHome()）
 * @returns {Promise<{ home: string, profiles: Array<object>, errors: string[] }>} 扫描结果
 */
export async function scanProfiles(home = resolveDshHome()) {
  const result = { home, profiles: [], errors: [] }
  let entries
  try {
    entries = await readdir(join(home, PROFILES_DIR), { withFileTypes: true })
  } catch (error) {
    result.errors.push(`profiles: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const profile = await scanProfile(join(home, PROFILES_DIR, entry.name), entry.name)
    if (profile !== null) result.profiles.push(profile)
  }
  result.profiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return result
}
