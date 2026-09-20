/**
 * dsh-plugin-management —— 清单 / 检查 / 更新 的业务实现。
 *
 * 只依赖两个注入口，方便单测与替换：
 *   run(command, { workdir, timeoutMs }) → { exitCode, stdout, stderr, timedOut }
 *   scan(home)                          → scanProfiles 的结果
 *
 * 三个动作：
 *   inventory({ profile?, check?, refresh? })  读清单（check=true 时顺带查最新版本）
 *   update({ profile?, names?, latest? })      跑更新（dsh plugin 优先，pnpm 兜底）
 *
 * @module dsh-plugin-management/inventory
 */

import {
  isOfficialName,
  isSafePackageName,
  isSafeProfileName,
  resolveDshHome,
  scanProfiles,
} from './scan.js'

/** `pnpm outdated` 的超时：要联网，给足但不无限等。 */
export const CHECK_TIMEOUT_MS = 120_000
/** 更新的超时：装包 + 解析依赖，慢网络下可能很久。 */
export const UPDATE_TIMEOUT_MS = 300_000
/** 回给前端的输出保留尾部多少字符。 */
const OUTPUT_TAIL_LIMIT = 4000
/** dsh CLI 缺失时的 stderr 特征（Windows cmd / POSIX shell 各一套）。 */
const COMMAND_MISSING_RE = /not recognized|command not found|No such file|不是内部或外部命令/i

/**
 * 取字符串尾部。
 * @param {unknown} value 任意值
 * @param {number} limit 保留字符数
 * @returns {string} 尾部字符串
 */
function tail(value, limit = OUTPUT_TAIL_LIMIT) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? text.slice(text.length - limit) : text
}

/** 包名升序（不用 localeCompare，保证跨平台结果一致）。 */
function byName(a, b) {
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/** 排序权重：跨大版本可升级 → 可更新 → 插件层 → 普通依赖。 */
function rank(row) {
  if (row.outdated === true && row.major === true) return 0
  if (row.outdated === true) return 1
  return row.layer === true ? 2 : 3
}

/** 先按权重再按包名。 */
function byRank(a, b) {
  const left = rank(a)
  const right = rank(b)
  return left === right ? byName(a, b) : left - right
}

/**
 * 建一行前端数据。
 * @param {object} item scanProfile 产出的依赖项
 * @param {object | null} info `pnpm outdated` 里对应条目（没有则视为最新/未检查）
 * @returns {object} 前端行
 */
export function buildRow(item, info) {
  const row = {
    name: item.name,
    spec: item.spec,
    installed: item.installed,
    layer: item.layer === true,
    local: item.local === true,
    declaresBundle: item.declaresBundle === true,
    updatable: item.local !== true,
    latest: null,
    wanted: null,
    outdated: false,
    inRange: false,
    major: false,
    deprecated: false,
  }
  if (info !== null && info !== undefined && typeof info === 'object') {
    if (typeof info.latest === 'string') row.latest = info.latest
    if (typeof info.wanted === 'string') row.wanted = info.wanted
    row.deprecated = info.isDeprecated === true
    row.outdated = row.latest !== null && row.installed !== null && row.latest !== row.installed
    row.inRange = row.wanted !== null && row.installed !== null && row.wanted !== row.installed
    row.major = row.latest !== null && row.wanted !== null && row.latest !== row.wanted
  }
  return row
}

/**
 * 建清单服务。
 * @param {object} deps 依赖注入
 * @param {(command: string, options?: object) => Promise<object>} deps.run 命令执行器
 * @param {(home?: string) => Promise<object>} [deps.scan] profile 扫描器
 * @param {string} [deps.home] 固定 dsh home（省略则按 $DSH_HOME / ~/.dsh 解析）
 * @param {() => ({ profile: string, home?: string } | null)} [deps.detectRunningProfile] 运行实例探测
 * @param {(message: string) => void} [deps.log] 日志
 * @returns {{ inventory: Function, update: Function, invalidate: Function, currentProfile: Function }}
 *   业务方法（全部返回 JSON 友好数据，不抛业务异常）
 */
export function createInventory({
  run,
  scan = scanProfiles,
  home,
  detectRunningProfile = () => null,
  log = () => {},
}) {
  /** 扫描缓存：profile 目录 + 依赖版本在一次会话里基本不变，更新后主动失效。 */
  let cache = null
  /** 当前运行实例的 profile 名（探测不到为 null）。 */
  let runningProfile = null

  /** 探测运行实例（容错：探测失败不影响清单）。 */
  function detect() {
    try {
      const detected = detectRunningProfile()
      if (detected !== null && typeof detected === 'object' && isSafeProfileName(detected.profile)) {
        runningProfile = detected.profile
        return typeof detected.home === 'string' && detected.home !== '' ? detected.home : null
      }
    } catch (error) {
      log(`running-profile detection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    runningProfile = null
    return null
  }

  /**
   * 读扫描结果（带缓存）。
   * @param {boolean} force 是否强制重扫
   * @returns {Promise<object>} 扫描结果
   */
  async function load(force) {
    if (cache !== null && force !== true) return cache
    const detectedHome = detect()
    const base = home ?? detectedHome ?? resolveDshHome()
    let snapshot = await scan(base)
    if (detectedHome !== null && detectedHome !== base && snapshot.profiles.length === 0) {
      snapshot = await scan(detectedHome)
    }
    cache = snapshot
    return cache
  }

  /**
   * 选目标 profile：显式指定（且存在）> 运行实例 > 外部插件最多 > 名为 web > 第一个。
   * @param {object} snapshot 扫描结果
   * @param {unknown} requested 调用方指定
   * @returns {string} profile 名
   */
  function resolveProfile(snapshot, requested) {
    const names = snapshot.profiles.map((profile) => profile.name)
    if (isSafeProfileName(requested) && names.includes(requested)) return requested
    if (runningProfile !== null && names.includes(runningProfile)) return runningProfile
    let best = null
    let bestCount = -1
    for (const profile of snapshot.profiles) {
      const count = profile.items.filter((item) => !isOfficialName(item.name)).length
      if (count > bestCount) {
        best = profile.name
        bestCount = count
      }
    }
    if (best !== null && bestCount > 0) return best
    if (names.includes('web')) return 'web'
    if (names.length > 0) return names[0]
    return isSafeProfileName(requested) ? requested : 'web'
  }

  /**
   * 查最新版本：pnpm outdated --format json。
   * @param {string} workdir profile 目录
   * @returns {Promise<{ ok: boolean, error: string | null, map: Record<string, object> | null }>} 结果
   */
  async function checkOutdated(workdir) {
    const result = await run('pnpm outdated --format json', {
      workdir,
      timeoutMs: CHECK_TIMEOUT_MS,
    })
    if (result.timedOut === true) return { ok: false, error: 'pnpm outdated timed out', map: null }
    const text = (result.stdout ?? '').trim()
    let map = null
    if (text !== '') {
      try {
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
      } catch {
        map = null
      }
    }
    if (map === null) {
      // 没有过期包时 pnpm 可能打印空/非 JSON；退出码 0 即“全部最新”。
      if (result.exitCode === 0) return { ok: true, error: null, map: {} }
      const detail = tail((result.stderr || result.stdout || '').trim(), 600)
      return { ok: false, error: detail || `pnpm outdated exited with ${result.exitCode}`, map: null }
    }
    // workspace 场景的 key 可能是 "proj > pkg"，统一取最后一段。
    const plain = {}
    for (const key of Object.keys(map)) {
      const name = key.includes(' > ') ? key.slice(key.lastIndexOf(' > ') + 3).trim() : key
      plain[name] = map[key]
    }
    return { ok: true, error: null, map: plain }
  }

  /**
   * 读清单。
   * @param {object} [request] 参数
   * @param {string} [request.profile] 目标 profile
   * @param {boolean} [request.check] 是否联网核对最新版本
   * @param {boolean} [request.refresh] 强制重扫 profile 目录
   * @returns {Promise<object>} 清单（失败时返回 { error }）
   */
  async function inventory(request = {}) {
    const args = request !== null && typeof request === 'object' ? request : {}
    const snapshot = await load(args.refresh === true)
    const profile = resolveProfile(snapshot, args.profile)
    const entry = snapshot.profiles.find((candidate) => candidate.name === profile) ?? null
    const external = entry === null ? [] : entry.items.filter((item) => !isOfficialName(item.name))
    const result = {
      home: snapshot.home,
      platform: process.platform,
      runningProfile,
      profiles: snapshot.profiles.map((candidate) => candidate.name),
      profile,
      profileDir: entry?.dir ?? null,
      exists: entry !== null,
      checked: false,
      checkError: null,
      plugins: external.map((item) => buildRow(item, null)).sort(byRank),
      bundleLayers: entry?.bundles.length ?? 0,
      externalLayers: entry === null ? 0 : entry.bundles.filter((name) => !isOfficialName(name)).length,
      scanErrors: snapshot.errors ?? [],
    }
    if (entry !== null && args.check === true) {
      const checked = await checkOutdated(entry.dir)
      result.checked = checked.ok === true
      result.checkError = checked.error
      const map = checked.map ?? {}
      result.plugins = external
        .map((item) =>
          buildRow(item, Object.hasOwn(map, item.name) ? map[item.name] : null),
        )
        .sort(byRank)
    }
    return result
  }

  /**
   * 更新外部插件。
   * 优先 `dsh plugin --profile <p> update ...`（官方转发器，会顺带把 dsh.bundle 变化
   * 重新对齐进 dsh.profile.bundles），dsh 不可用时退 `pnpm update ...`（cwd = profile 目录）。
   * @param {object} [request] 参数
   * @param {string} [request.profile] 目标 profile
   * @param {string[]} [request.names] 指定包名（省略 = 该 profile 全部外部插件；
   *   给了但全不合法/全不命中 = 什么都不更新，不会回落成“全部”）
   * @param {boolean} [request.latest] true 时加 --latest（跨大版本，会改写版本范围）
   * @returns {Promise<object>} 执行结果（含命令、退出码、输出尾部）
   */
  async function update(request = {}) {
    const args = request !== null && typeof request === 'object' ? request : {}
    const snapshot = await load(false)
    const profile = resolveProfile(snapshot, args.profile)
    const entry = snapshot.profiles.find((candidate) => candidate.name === profile) ?? null
    if (entry === null) throw new Error(`profile not found: ${profile}`)
    const requested = Array.isArray(args.names) ? args.names : null
    const wanted = requested === null ? null : requested.filter(isSafePackageName)
    const candidates = entry.items.filter((item) => !isOfficialName(item.name) && item.local !== true)
    // 关键语义：names 一旦给了（哪怕全被过滤掉），就只更新交集，绝不回退成“全部更新”。
    const selected = wanted === null ? candidates : candidates.filter((item) => wanted.includes(item.name))
    const targets = selected.map((item) => item.name)
    if (targets.length === 0) {
      return {
        ok: true,
        profile,
        names: [],
        changed: false,
        restartRequired: false,
        message: 'no external plugin to update',
      }
    }
    const useLatest = args.latest === true
    const flags = `${useLatest ? '--latest ' : ''}${targets.join(' ')}`
    const primary = `dsh plugin --profile ${profile} update ${flags}`
    let result = await run(primary, { workdir: entry.dir, timeoutMs: UPDATE_TIMEOUT_MS })
    let command = primary
    if (result.exitCode !== 0 && COMMAND_MISSING_RE.test(`${result.stdout}\n${result.stderr}`)) {
      command = `pnpm update ${flags}`
      result = await run(command, { workdir: entry.dir, timeoutMs: UPDATE_TIMEOUT_MS })
    }
    cache = null
    return {
      ok: result.exitCode === 0 && result.timedOut !== true,
      profile,
      names: targets,
      latest: useLatest,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      changed: result.exitCode === 0,
      // 就地替换已加载的包不等于生效：新版本要重启 dsh 才会被 Loader 读进进程。
      restartRequired: result.exitCode === 0,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    }
  }

  return {
    inventory,
    update,
    invalidate() {
      cache = null
    },
    currentProfile() {
      return runningProfile
    },
  }
}
