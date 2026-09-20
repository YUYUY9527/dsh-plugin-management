/**
 * dsh-plugin-management —— host half（cordis 插件）。
 *
 * 两件事：
 *   1. 给浏览器面板开一条同源 JSON API（ctx.webServer，前缀路由）：
 *        GET  <apiPath>/inventory?profile=&check=1&refresh=1
 *        POST <apiPath>/update     { profile?, names?, latest? }
 *   2. 注册模型工具 `external_plugins`（list / update），让 agent 也能自己查与更新。
 *
 * 刻意不写死任何硬依赖：webServer / tools / shell 都用 ctx.inject 或 ctx.get 惰性取，
 * 缺哪个就少哪半边能力，绝不会因为某个服务不在而整个插件卡在 waiting。
 *
 * @module dsh-plugin-management
 */

import { createRunner } from './exec.js'
import { createInventory } from './inventory.js'
import { createToolSpec, toRawToolSpec } from './tool.js'

/** Loader 行 id / 包名（cordis.patch.yml 里的 id 与 name 必须与此一致）。 */
export const name = 'dsh-plugin-management'
/** 默认 HTTP 前缀；可用 patch 的 config.apiPath 覆盖（仅在路由撞车时需要）。 */
export const DEFAULT_API_PATH = '/dsh-plugin-management/api'
/** POST body 上限，挡住异常大请求。 */
const BODY_LIMIT_BYTES = 64 * 1024

/**
 * 统一日志出口：有 ctx.logger 用它（进 dsh 自己的日志），否则退回 console。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {'info' | 'warn' | 'error'} level 级别
 * @param {string} message 正文（会带上插件名前缀）
 * @returns {void}
 */
function log(ctx, level, message) {
  const line = `${name}: ${message}`
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') logger[level](line)
  else if (level === 'warn' || level === 'error') console.error(line)
  else console.log(line)
}

/**
 * 规范化 apiPath：必须是绝对路径，去掉尾部斜杠。
 * @param {unknown} value config.apiPath
 * @returns {string} 可用的前缀路径
 */
function normalizeApiPath(value) {
  if (typeof value !== 'string') return DEFAULT_API_PATH
  const trimmed = value.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('/')) return DEFAULT_API_PATH
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

/**
 * 同源校验：浏览器 fetch 会带 Origin，跨站页面发起的请求一律拒绝
 * （本插件能触发 pnpm 安装，必须挡住 CSRF）。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {boolean} 同源或未带 Origin 为 true
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 读一个有上限的 JSON body。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>} 解析后的 body（空 body 为 {}）
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * 目录里有没有 profile 名：从运行实例的 client bundle 绝对路径反推
 * （<home>/profiles/<name>/node_modules/...）。这是“当前跑的到底是哪个 profile”
 * 最可靠的本地证据，clientModules 不存在时返回 null，由 inventory 自己兜底。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @returns {{ profile: string, home: string | null } | null} 探测结果
 */
function detectRunningProfile(ctx) {
  const clientModules = ctx.get('clientModules')
  if (clientModules === undefined || typeof clientModules.graph !== 'function') return null
  const graph = clientModules.graph()
  const entries = Array.isArray(graph?.entries) ? graph.entries : []
  for (const entry of entries) {
    if (typeof entry?.id !== 'string') continue
    const file = clientModules.clientPath(entry.id)
    if (typeof file !== 'string') continue
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]/.exec(file)
    if (match === null || match[1] === 'node_modules') continue
    return { profile: match[1], home: file.slice(0, match.index) }
  }
  return null
}

/**
 * HTTP 处理器：只认 /inventory 与 /update，其余 404。
 * @param {{ inventory: Function, update: Function }} service 清单服务
 * @param {string} apiPath 已注册的前缀
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @param {() => ({ state: string, error: string | null })} [getToolStatus] 工具状态快照
 * @returns {Promise<void>} 响应写完即结束
 */
async function handleApi(service, apiPath, req, res, getToolStatus) {
  const send = (code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  try {
    if (!sameOrigin(req)) {
      send(403, { error: 'cross-origin request rejected' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(apiPath.length) || '/'
    const flag = (key) => {
      const value = url.searchParams.get(key)
      return value === '1' || value === 'true'
    }
    if (req.method === 'GET' && (route === '/' || route === '/inventory')) {
      const payload = await service.inventory({
        profile: url.searchParams.get('profile') ?? undefined,
        check: flag('check'),
        refresh: flag('refresh'),
      })
      // 工具注册状态一起回给面板：host 层注册失败时只在日志里可见太难查了。
      send(200, { ...payload, tool: typeof getToolStatus === 'function' ? getToolStatus() : null })
      return
    }
    if (req.method === 'POST' && route === '/update') {
      const body = await readJsonBody(req)
      send(
        200,
        await service.update({
          profile: body?.profile,
          names: body?.names,
          latest: body?.latest === true,
        }),
      )
      return
    }
    send(404, { error: `unknown route: ${req.method} ${url.pathname}` })
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** defineTool 的惰性加载缓存：undefined = 还没试过，null = 试过但没有。 */
let defineToolCache

/**
 * 取 `@deepseek-ai/dsh-tools` 的 defineTool（可选依赖）。
 * 拿不到就返回 null，由调用方回落到本地 JSON Schema 注册——
 * 外挂包不该因为一个可选包解析不到就整个加载失败。
 * @returns {Promise<Function | null>} defineTool 或 null
 */
async function loadDefineTool() {
  if (defineToolCache === undefined) {
    defineToolCache = import('@deepseek-ai/dsh-tools')
      .then((mod) => (typeof mod?.defineTool === 'function' ? mod.defineTool : null))
      .catch(() => null)
  }
  return defineToolCache
}

/**
 * 注册模型工具。
 *
 * 两条路，形状必须匹配各自的消费者（这里踩过坑）：
 *   1. 能解析到 `@deepseek-ai/dsh-tools` → `defineTool(DSL 形态)`，附带参数校验；
 *   2. 解析不到 → `toRawToolSpec()` 自己转成 raw JSON Schema 再 `register()`。
 * 绝不把 DSL 直接丢给 register（`{type:'json'}` 会被断言拒绝，工具会静默消失）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {{ inventory: Function, update: Function }} service 清单服务
 * @returns {{ state: string, error: string | null }} 工具状态（会随 /inventory 回给面板）
 */
function registerTool(ctx, service) {
  const status = { state: 'waiting-for-tools', error: null }
  ctx.inject(['tools'], (toolsCtx) => {
    status.state = 'mounting'
    toolsCtx.effect(() => {
      let dispose = null
      let cancelled = false
      const mount = async () => {
        const spec = createToolSpec(service)
        const defineTool = await loadDefineTool()
        let definition = null
        if (defineTool !== null) {
          try {
            definition = defineTool(spec)
          } catch (error) {
            status.error = `defineTool: ${error instanceof Error ? error.message : String(error)}`
            log(ctx, 'warn', `defineTool rejected the spec, falling back to a raw definition - ${status.error}`)
          }
        }
        if (definition === null) definition = toRawToolSpec(spec)
        if (cancelled) return
        try {
          dispose = toolsCtx.tools.register(definition)
          status.state = 'registered'
          status.error = null
        } catch (error) {
          status.state = 'failed'
          status.error = error instanceof Error ? error.message : String(error)
          log(ctx, 'warn', `tool registration failed - ${status.error}`)
        }
      }
      void mount()
      return () => {
        cancelled = true
        status.state = 'disposed'
        if (dispose !== null) dispose()
      }
    }, `${name}: tool`)
  })
  return status
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {{ apiPath?: string }} [config] 行配置
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const apiPath = normalizeApiPath(config?.apiPath)
  const service = createInventory({
    run: createRunner(ctx),
    detectRunningProfile: () => detectRunningProfile(ctx),
    log: (message) => ctx.logger?.info?.(message),
  })

  const toolStatus = registerTool(ctx, service)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: apiPath,
          handler: (req, res) => handleApi(service, apiPath, req, res, () => ({ ...toolStatus })),
        }),
      `${name}: api`,
    )
  })

  registerTool(ctx, service)
}