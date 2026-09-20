/**
 * tool.js 单测：参数 DSL → JSON Schema、参数守卫、以及 execute 的分派。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PARAMETERS, createToolSpec, normalizeArgs, parameterSpecToJsonSchema } from '../lib/tool.js'

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
