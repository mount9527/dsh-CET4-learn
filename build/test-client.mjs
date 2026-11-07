/**
 * 客户端模块自检：不启动 DSH，用一个最小的 React / 插槽桩验证
 *   - lib/client.js 能被 __ModuleLoader__ 加载，导出 name / inject / apply
 *   - apply(ctx) 会注册 1 个左侧栏图标 + 1 个 main 面板
 *   - 图标与面板能渲染出节点（桩环境只检查返回结构）
 *   node build/test-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 最小 React 桩 ── */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useRef: (v) => ({ current: v }),
  useState: (v) => [v, () => {}],
  useLayoutEffect: () => {},
  useEffect: () => {},
}

/* ── 最小 slots / layout 服务桩 ── */
const registered = []
const ctx = {
  slots: {
    inject(name, fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {
        const i = registered.findIndex((r) => r.options === options)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  },
  layout: { selectPanel() {} },
  effect(fn) {
    return fn()
  },
}

/* ── 加载客户端模块 ── */
let factory
const sandbox = { __ModuleLoader__: { load: ({ id, factory: f }) => ((factory = f), (sandbox.loadedId = id)) } }
globalThis.window = sandbox

const code = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
new Function('window', code)(sandbox)
if (!factory) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
console.log('loader id:', sandbox.loadedId)

const mod = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
console.log('exports:', Object.keys(mod).join(', '))
console.log('inject:', JSON.stringify(mod.inject))

if (typeof mod.apply !== 'function') throw new Error('缺少 apply')
mod.apply(ctx)

console.log('registrations:')
for (const { options, component } of registered) {
  console.log(`  - ${options.name}${options.key ? ` key=${options.key}` : ''}${options.id ? ` id=${options.id}` : ''}`)
  if (typeof component !== 'function') throw new Error(`${options.name} 的组件不是函数`)
}

const icon = registered.find((r) => r.options.name === 'sidebar.panellist')
const main = registered.find((r) => r.options.name === 'main')
if (!icon) throw new Error('没有注册 sidebar.panellist')
if (!main) throw new Error('没有注册 main')
if (icon.options.id !== main.options.key) throw new Error('图标 id 与面板 key 不一致，点击图标不会切到面板')
if (typeof icon.options.label !== 'function' || !icon.options.label()) throw new Error('图标 label 无效')

/* 图标渲染：应产出 span > svg */
const iconNode = icon.component({ size: 18 })
if (iconNode.type !== 'span' || iconNode.children[0]?.type !== 'svg') throw new Error('图标结构异常')

/* 面板渲染：应产出 div > iframe，src 指向 /cet4/app/index.html */
const panelNode = main.component({})
if (panelNode.type !== 'div') throw new Error('面板外层不是 div')
const frame = panelNode.children[0]
if (frame?.type !== 'iframe') throw new Error('面板里没有 iframe')
if (frame.props.src !== '/cet4/app/index.html') throw new Error(`iframe src 异常：${frame.props.src}`)

console.log('iframe src:', frame.props.src)
console.log('\n✅ 客户端模块自检通过')
