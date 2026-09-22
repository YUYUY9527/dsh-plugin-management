/**
 * dsh-plugin-management —— 模型工具定义。
 *
 * ⚠️ 两种 schema 形态必须分清（这里踩过坑，注释留证）：
 *
 *   author-facing DSL  —— `parameters` 是 { 参数名: { type, required, enum, ... } }；
 *                         `output.schema` 允许 author-only 的 `{ type: 'json' }`。
 *                         只有 `defineTool()` 消费这种形态。
 *   raw JSON Schema    —— `parameters` 是 { type:'object', properties, required }；
 *                         且 schema.type 只能是 object/array/string/number/integer/boolean/null
 *                         （`json` 非法，它等价于空 schema `{}`）。
 *                         `ctx.tools.register()` 只接受这种形态。
 *
 * 所以：createToolSpec() 产出 DSL（交给 defineTool）；拿不到 defineTool 时用
 * toRawToolSpec() 自己转成 raw 形态再注册 —— 两条路的产物形状已实测一致。
 *
 * @module dsh-plugin-management/tool
 */

import { isSafePackageName, isSafeProfileName } from './scan.js'

/** 工具名（对 agent 可见）。 */
export const TOOL_NAME = 'external_plugins'

/** 参数（dsh 的 ParameterSchemaSpec 形态，只用到 string/enum/array/boolean）。 */
export const PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['list', 'update'],
    description: 'list reads the inventory; update installs newer versions.',
  },
  profile: {
    type: 'string',
    description:
      'dsh profile name; omit to use the profile this process is running (or the one with external plugins).',
  },
  names: {
    type: 'array',
    items: { type: 'string' },
    description: 'Package names to update; omit to update every external plugin of the profile.',
  },
  latest: {
    type: 'boolean',
    description: 'true forwards --latest, rewriting the version range to the newest major.',
  },
  check: {
    type: 'boolean',
    description:
      'For action=list: query the registry for newest versions (default true; costs a pnpm outdated round trip).',
  },
}

/** 工具说明（给模型看，写清边界与副作用）。 */
export const DESCRIPTION =
  'List and update external (non-official) plugins installed in a dsh profile. action="list" returns every external dependency of the profile: installed version, latest version, whether it is an active dsh.profile.bundles layer, whether it is a registry package or a local link, and installCommand — a ready-to-run `dsh plugin --profile <p> add …` for exactly that package. action="update" runs `dsh plugin --profile <p> update [--latest] <names|all>` (pnpm fallback) and returns the command output; a package replaced in place is only loaded after dsh restarts.'

/**
 * ParameterSchemaSpec → JSON Schema（本插件用到的那几种子集）。
 * 在拿不到 defineTool 时使用；与 defineTool 产出的形状一致：
 * 隐式参数对象，additionalProperties: false，required 显式列出。
 * @param {Record<string, any>} [spec] 参数 DSL
 * @returns {object} JSON Schema
 */
export function parameterSpecToJsonSchema(spec = PARAMETERS) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const node = { type: value.type }
    if (Array.isArray(value.enum)) node.enum = [...value.enum]
    if (typeof value.description === 'string') node.description = value.description
    if (value.type === 'array' && value.items !== undefined) {
      const items = { type: value.items.type }
      if (Array.isArray(value.items.enum)) items.enum = [...value.items.enum]
      if (typeof value.items.description === 'string') items.description = value.items.description
      node.items = items
    }
    if (value.required === true) required.push(key)
    properties[key] = node
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * 校验一次工具调用的参数（本地兜底路径用；defineTool 路径由它自己校验）。
 * @param {any} args 原始参数
 * @returns {{ action: string, profile?: string, names?: string[], latest?: boolean, check?: boolean }}
 *   规范化后的参数
 * @throws {Error} 参数非法
 */
export function normalizeArgs(args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  const action = value.action
  if (action !== 'list' && action !== 'update') {
    throw new Error('action must be "list" or "update"')
  }
  const normalized = { action }
  if (value.profile !== undefined && value.profile !== null && value.profile !== '') {
    if (!isSafeProfileName(value.profile)) throw new Error(`invalid profile name: ${String(value.profile)}`)
    normalized.profile = value.profile
  }
  if (value.names !== undefined) {
    if (!Array.isArray(value.names)) throw new Error('names must be an array of package names')
    const names = value.names.filter(isSafePackageName)
    if (names.length !== value.names.length) throw new Error('names contains an invalid package name')
    normalized.names = names
  }
  if (value.latest !== undefined) normalized.latest = value.latest === true
  if (value.check !== undefined) normalized.check = value.check !== false
  return normalized
}

/**
 * author-facing value schema → 受支持的 raw JSON Schema。
 * `{ type: 'json' }`（任意 JSON）在 raw 形态里就是空 schema `{}`。
 * @param {any} [spec] author-facing 值 schema
 * @returns {object} raw JSON Schema（本插件只会传 { type: 'json' }）
 */
export function valueSpecToJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object') return {}
  if (spec.type === 'json') return {}
  const schema = { type: spec.type }
  if (typeof spec.description === 'string') schema.description = spec.description
  return schema
}

/**
 * 造工具定义（**author-facing DSL 形态**，交给 defineTool 用）。
 * @param {{ inventory: Function, update: Function }} service 清单服务
 * @returns {object} defineTool 可消费的定义
 */
export function createToolSpec(service) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    // DSL：{ 参数名: { type, required, enum, description } }，不是 JSON Schema
    parameters: PARAMETERS,
    output: {
      // author-only 节点，defineTool 会转成 raw 的 {}
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs) {
      let args
      try {
        args = normalizeArgs(rawArgs)
      } catch (error) {
        // 与业务异常一致：参数问题也回 JSON error，而不是把栈抛给调度层
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (args.action === 'update') {
        try {
          return await service.update(args)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      const check = args.check !== false
      try {
        return await service.inventory({ profile: args.profile, check })
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * 把 DSL 形态转成 raw JSON Schema 形态，可直接交给 `ctx.tools.register()`。
 * 只在解析不到 `@deepseek-ai/dsh-tools` 时使用；形状与 defineTool 的产物一致。
 * @param {object} spec createToolSpec 的结果
 * @returns {object} raw ToolDefinition
 */
export function toRawToolSpec(spec) {
  return {
    ...spec,
    parameters: parameterSpecToJsonSchema(spec.parameters),
    output: { ...spec.output, schema: valueSpecToJsonSchema(spec.output?.schema) },
  }
}
