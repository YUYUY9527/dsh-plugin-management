/**
 * tool.js 单测：参数 DSL → JSON Schema、参数守卫、以及 execute 的分派。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PARAMETERS, createToolSpec, normalizeArgs, parameterSpecToJsonSchema, toRawToolSpec, valueSpecToJsonSchema } from '../lib/tool.js'

/**
 * 回归：schema 形态必须匹配各自的消费者。
 * 曾经把 JSON-Schema 形态喂给 defineTool、又把 {type:'json'} 喂给 register()，
 * 结果工具静默不注册（v1.0.0 的真实故障）。
 */
test('createToolSpec 产出 DSL 形态（交给 defineTool，而不是 register）', () => {
  const spec = createToolSpec({ inventory: async () => ({}), update: async () => ({}) })
  // DSL 的标志：直接以参数名为键，且没有 JSON Schema 的 properties 包装
  assert.equal(spec.parameters.action.type, 'string')
  assert.equal(spec.parameters.action.required, true)
  assert.deepEqual(spec.parameters.action.enum, ['list', 'update'])
  assert.equal(spec.parameters.properties, undefined, 'parameters 不能是 JSON Schema')
  // output.schema 是 author-only 的 json 节点，defineTool 会转成 {}
  assert.deepEqual(spec.output.schema, { type: 'json' })
  assert.equal(typeof spec.execute, 'function')
  assert.equal(typeof spec.output.render, 'function')
})

test('toRawToolSpec 产出可交给 ctx.tools.register 的 raw 形态', () => {
  const raw = toRawToolSpec(createToolSpec({ inventory: async () => ({}), update: async () => ({}) }))
  assert.equal(raw.parameters.type, 'object')
  assert.equal(raw.parameters.additionalProperties, false)
  assert.deepEqual(raw.parameters.required, ['action'])
  assert.deepEqual(raw.parameters.properties.action.enum, ['list', 'update'])
  // 关键：raw 形态里 {type:'json'} 非法，必须降级为「任意 JSON」= {}
  assert.deepEqual(raw.output.schema, {})
  assert.equal(raw.output.schema.type, undefined)
})

test('valueSpecToJsonSchema：json 节点等价于空 schema', () => {
  assert.deepEqual(valueSpecToJsonSchema({ type: 'json' }), {})
  assert.deepEqual(valueSpecToJsonSchema(undefined), {})
  assert.deepEqual(valueSpecToJsonSchema({ type: 'string' }), { type: 'string' })
})

test('parameterSpecToJsonSchema：隐式参数对象 + required + enum', () => {
  const schema = parameterSpecToJsonSchema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['action'])
  assert.deepEqual(schema.properties.action.enum, ['list', 'update'])
  assert.equal(schema.properties.action.type, 'string')
  assert.equal(schema.properties.names.type, 'array')
  assert.equal(schema.properties.names.items.type, 'string')
  assert.equal(schema.properties.latest.type, 'boolean')
  assert.equal(schema.properties.profile.type, 'string')
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(PARAMETERS).sort())
})

test('normalizeArgs：只放行合法输入', () => {
  assert.deepEqual(normalizeArgs({ action: 'list' }), { action: 'list' })
  assert.deepEqual(normalizeArgs({ action: 'update', profile: 'web', names: ['dsh-a'], latest: true, check: false }), {
    action: 'update',
    profile: 'web',
    names: ['dsh-a'],
    latest: true,
    check: false,
  })
  assert.throws(() => normalizeArgs({ action: 'destroy' }), /action must be/)
  assert.throws(() => normalizeArgs({}), /action must be/)
  assert.throws(() => normalizeArgs({ action: 'list', profile: '../etc' }), /invalid profile name/)
  assert.throws(() => normalizeArgs({ action: 'update', names: 'dsh-a' }), /names must be an array/)
  assert.throws(() => normalizeArgs({ action: 'update', names: ['dsh-a; rm -rf /'] }), /invalid package name/)
})

test('createToolSpec：execute 分派到 inventory / update，并只暴露 JSON 结果', async () => {
  const calls = []
  const service = {
    inventory: async (request) => {
      calls.push({ kind: 'inventory', request })
      return { profile: 'web', plugins: [] }
    },
    update: async (request) => {
      calls.push({ kind: 'update', request })
      return { ok: true, names: request.names }
    },
  }
  const spec = createToolSpec(service)
  assert.equal(spec.name, 'external_plugins')
  assert.equal(typeof spec.execute, 'function')

  const listed = await spec.execute({ action: 'list' })
  assert.deepEqual(listed, { profile: 'web', plugins: [] })
  assert.deepEqual(calls[0], { kind: 'inventory', request: { profile: undefined, check: true } })

  await spec.execute({ action: 'list', check: false, profile: 'web' })
  assert.deepEqual(calls[1], { kind: 'inventory', request: { profile: 'web', check: false } })

  const updated = await spec.execute({ action: 'update', names: ['dsh-a'], latest: true })
  assert.deepEqual(updated, { ok: true, names: ['dsh-a'] })
  assert.deepEqual(calls[2], { kind: 'update', request: { action: 'update', names: ['dsh-a'], latest: true } })

  // 渲染：输出必须是 text content block（模型看得见的唯一出口）
  const rendered = spec.output.render({}, { ok: true })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /"ok": true/)
})

test('createToolSpec：业务异常转成 JSON error，不把栈抛给模型', async () => {
  const service = {
    inventory: async () => {
      throw new Error('scan exploded')
    },
    update: async () => {
      throw new Error('profile not found: nope')
    },
  }
  const spec = createToolSpec(service)
  assert.deepEqual(await spec.execute({ action: 'list' }), { error: 'scan exploded' })
  assert.deepEqual(await spec.execute({ action: 'update', profile: 'nope' }), {
    ok: false,
    error: 'profile not found: nope',
  })
})

test('createToolSpec：非法参数回 JSON error（真实调度会比这更早拦一次）', async () => {
  const spec = createToolSpec({ inventory: async () => ({}), update: async () => ({}) })
  const result = await spec.execute({ action: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.error, /action must be/)
  // 两条路（defineTool / raw）都不该把参数异常抛给调度层
  const raw = toRawToolSpec(spec)
  const rawResult = await raw.execute({ action: 'nope' })
  assert.equal(rawResult.ok, false)
  assert.match(rawResult.error, /action must be/)
})
