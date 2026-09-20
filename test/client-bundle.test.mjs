/**
 * client.js 单测：不装浏览器，直接给 __ModuleLoader__ / document 打桩，
 * 验证 bundle 的包装、导出形状与 slot 注册——这是最容易悄悄写错的一层。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** 读 bundle 源码并在打桩的全局环境里执行它。 */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const captured = []
  const windowStub = { __ModuleLoader__: { load: (spec) => captured.push(spec) } }
  const documentStub = {
    createElement: () => ({ textContent: '', remove() {} }),
    head: { appendChild() {} },
  }
  // 浏览器里是 <script> 直接执行；这里用 Function 复刻同样的全局语义。
  new Function('window', 'document', source)(windowStub, documentStub)
  assert.equal(captured.length, 1, 'bundle 必须调用一次 __ModuleLoader__.load')
  return captured[0]
}

/** 最小 React 打桩：只要 createElement 与两个 hook。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
}

test('client bundle：id 用包名，factory 只 require react', async () => {
  const spec = await loadBundle()
  assert.equal(spec.id, 'dsh-plugin-management')
  assert.equal(typeof spec.factory, 'function')
  const requested = []
  const exports = spec.factory((id) => {
    requested.push(id)
    if (id === 'react') return reactStub()
    throw new Error(`unexpected require: ${id}`)
  })
  assert.deepEqual(requested, ['react'])
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('client bundle：apply 注入样式并注册「外部插件」tab', async () => {
  const spec = await loadBundle()
  const exports = spec.factory(() => reactStub())
  const injected = []
  const registered = []
  let styleRemoved = false
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(injected, ['settings.plugins.tab'])
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.plugins.tab', 'register 必须带 name（slot 名）')
  assert.equal(options.id, 'plugin-management')
  assert.equal(options.order, 20)
  assert.equal(typeof options.label(), 'string')
  assert.ok(options.label().length > 0)
  // 组件工厂返回 <Panel/> 元素；再调一次 Panel 本体，验证树根正确（不渲染）
  const element = component({})
  assert.equal(typeof element.type, 'function')
  const tree = element.type(element.props)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dsh-pm')
  assert.equal(styleRemoved, false)
})

test('client bundle：取词跟随 locale，取不到时用中文', async () => {
  const spec = await loadBundle()
  const exports = spec.factory(() => reactStub())
  const registered = []
  const makeCtx = (localeSnapshot) => ({
    get: (key) => (key === 'locale' && localeSnapshot ? { getSnapshot: () => localeSnapshot } : undefined),
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  })

  exports.apply(makeCtx({ id: 'en-US' }))
  assert.equal(registered[0].options.label(), 'External plugins')

  exports.apply(makeCtx({ id: 'zh-CN' }))
  assert.equal(registered[1].options.label(), '外部插件')

  exports.apply(makeCtx(undefined))
  assert.equal(registered[2].options.label(), '外部插件')
})
