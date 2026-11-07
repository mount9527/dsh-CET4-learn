/**
 * dsh-cet4 —— 宿主侧：把 app/ 与题库静态挂到 /cet4 前缀上，并把听力录音按 Range 推流。
 *
 * 为什么音频不放进包里：
 *   真题、录音、词汇资料的版权归原权利人，本插件只分发代码。data/*.json 由使用者在自己的
 *   资料目录上运行 `npm run build:data` 生成，录音则直接从资料目录读取（data/media.json 里
 *   记着相对路径），所以仓库/安装包里没有任何真题内容。
 *
 * 题库放在哪：
 *   默认 ~/.dsh/dsh-cet4/data，可用 CET4_DATA 覆盖；插件目录内的 data/ 只在开发时兜底。
 *   详见 lib/data-dir.js —— 装在 node_modules 里升级不会被清掉。
 *
 * 安全边界：
 *   - 只放行 app/ 与题库目录，路径越界一律 404；
 *   - 音频只按 media.json 里登记过的音轨 id 取文件，解析后还要校验仍在资料目录之内；
 *   - 只接受本机回环请求（CET4_ALLOW_REMOTE=1 可放开，但同样有风险）；
 *   - 静态资源带 CSP，只能被宿主 GUI 自己嵌。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from './lib/data-dir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '/cet4'
const MEDIA_PREFIX = `${PREFIX}/media/`
const ENTRY = `${PREFIX}/app/index.html`

/** 回环地址白名单：非本机请求默认拒绝，避免把本机录音变成对外服务。 */
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])
const isLocalRequest = (req) => {
  if (process.env.CET4_ALLOW_REMOTE === '1') return true
  const addr = req.socket?.remoteAddress
  // 没有 socket 地址（例如宿主内部直接调用 handler）时按本机处理
  if (!addr) return true
  if (LOCAL_ADDRS.has(addr)) return true
  return addr.startsWith('127.') || addr === '::ffff:127.0.0.1'
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': CSP,
}

const notFound = (res, msg = 'not found') => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS })
  res.end(msg)
}

/* ────────────────────────── 静态资源 ────────────────────────── */

/** 把 URL 路径解析成磁盘路径；/cet4/app/* 落到插件目录，/cet4/data/* 落到题库目录。 */
function resolveFile(rawPathname, dataDir) {
  let rel
  try {
    rel = decodeURIComponent(rawPathname.slice(PREFIX.length))
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  rel = rel.replace(/^[\\/]+/, '')
  if (rel === '') return null

  const [head, ...rest] = rel.split(/[\\/]/)
  const base = head === 'app' ? path.join(HERE, 'app') : head === 'data' ? dataDir : null
  if (!base) return null

  const abs = path.resolve(base, ...rest)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return abs
}

async function serveStatic(req, res, pathname, dataDir) {
  if (pathname === PREFIX || pathname === `${PREFIX}/`) {
    res.writeHead(302, { location: ENTRY, 'cache-control': 'no-store' })
    res.end()
    return
  }

  let abs = resolveFile(pathname, dataDir)
  if (!abs) return notFound(res)

  let stat = await fsp.stat(abs).catch(() => null)
  if (stat?.isDirectory()) {
    abs = path.join(abs, 'index.html')
    stat = await fsp.stat(abs).catch(() => null)
  }
  if (!stat?.isFile()) return notFound(res)

  const ext = path.extname(abs).toLowerCase()
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': String(stat.size),
    // 题库会随时被替换，所以一律回源校验（命中 304 也很便宜）
    'cache-control': 'no-cache',
    'last-modified': stat.mtime.toUTCString(),
    ...SECURITY_HEADERS,
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }

  res.writeHead(200, headers)
  await new Promise((resolve) => {
    const stream = fs.createReadStream(abs)
    stream.on('error', () => {
      res.destroy()
      resolve()
    })
    stream.on('end', resolve)
    res.on('close', () => {
      stream.destroy()
      resolve()
    })
    stream.pipe(res)
  })
}

/* ────────────────────────── 听力录音（Range 推流） ────────────────────────── */

function readMediaIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'media.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 解析 Range 头，返回 { start, end } 或 null（不支持/格式不对就整段返回） */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m) return null
  let start = m[1] === '' ? null : Number(m[1])
  let end = m[2] === '' ? null : Number(m[2])
  if (start == null && end == null) return null
  if (start == null) {
    // bytes=-N：最后 N 字节
    start = Math.max(0, size - end)
    end = size - 1
  } else if (end == null || end >= size) end = size - 1
  if (start > end || start >= size) return { invalid: true }
  return { start, end }
}

async function serveMedia(req, res, sub, dataDir) {
  const media = readMediaIndex(dataDir)
  if (!media) return notFound(res, '题库未生成（缺 media.json）')

  let id
  try {
    id = decodeURIComponent(sub).replace(/\.(aac|m4a|mp3|ogg|wav)$/i, '')
  } catch {
    return notFound(res, 'bad request')
  }
  const entry = media.tracks?.[id]
  if (!entry) return notFound(res, '没有这份录音')

  const root = path.resolve(process.env.CET4_SRC || media.root || '')
  const abs = path.resolve(root, entry.file)
  if (!root || !abs.startsWith(root + path.sep)) return notFound(res, '资料目录配置无效')

  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat?.isFile()) return notFound(res, '录音文件不在了，请检查资料目录')

  const ext = path.extname(abs).toLowerCase()
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'last-modified': stat.mtime.toUTCString(),
    ...SECURITY_HEADERS,
  }

  const range = parseRange(req.headers.range, stat.size)
  if (range?.invalid) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` })
    res.end()
    return
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
    res.end()
    return
  }

  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
    fs.createReadStream(abs).pipe(res)
    return
  }

  res.writeHead(206, {
    ...headers,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
  })
  fs.createReadStream(abs, { start: range.start, end: range.end }).pipe(res)
}

/* ────────────────────────── 路由 ────────────────────────── */

async function serve(req, res) {
  const method = req.method || 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }

  // 本机工具不该对外提供服务：非回环请求一律拒绝，免得开了远程访问就把录音发出去了
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
    res.end('本插件只服务本机请求')
    return
  }

  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  } catch {
    return notFound(res, 'bad request')
  }

  const { dir: dataDir } = resolveDataDir()

  if (pathname.startsWith(MEDIA_PREFIX)) {
    await serveMedia(req, res, pathname.slice(MEDIA_PREFIX.length), dataDir)
    return
  }
  await serveStatic(req, res, pathname, dataDir)
}

export const name = 'dsh-cet4'
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-cet4] 没有可用的 webServer 服务，插件未挂载路由')
    return
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) =>
          serve(req, res).catch((error) => {
            ctx.logger?.warn?.(`[dsh-cet4] ${req.url} 处理失败：${error?.message ?? error}`)
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('internal error')
            } else res.destroy()
          }),
      }),
    'dsh-cet4: /cet4 静态资源与听力录音',
  )

  ctx.logger?.info?.(`[dsh-cet4] 训练台已挂载：${ENTRY}`)

  const { dir, source } = resolveDataDir()
  if (source === 'missing') {
    ctx.logger?.warn?.(
      `[dsh-cet4] 还没找到题库：${dir} —— 在自己的资料目录上跑 \`npm run build:data\` 生成（可用 CET4_DATA 指定位置）`,
    )
  } else {
    ctx.logger?.info?.(`[dsh-cet4] 题库目录：${dir}`)
  }
}
