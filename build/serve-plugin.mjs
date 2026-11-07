/**
 * 单独跑一遍插件的宿主路由，用来验证 /cet4 静态托管是否正常（不需要启动 DSH）。
 *   node build/serve-plugin.mjs [port]
 * 然后访问 http://127.0.0.1:8788/cet4/app/index.html
 */
import http from 'node:http'

const port = Number(process.argv[2] || 8788)
const routes = []

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
  effect(fn) {
    return fn()
  },
  logger: { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a) },
}

const mod = await import('../index.js')
mod.apply(ctx)

console.log('registers:', routes.map((r) => `${r.kind} ${r.path}`))

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  const hit = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path))
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('no route')
    return
  }
  Promise.resolve(hit.handler(req, res)).catch((e) => {
    res.writeHead(500)
    res.end(String(e))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`plugin preview: http://127.0.0.1:${port}/cet4/app/index.html`)
})
