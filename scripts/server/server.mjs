#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Universe Editor 更新分发用的零依赖静态 HTTP 服务器。
 *
 *  electron-updater 的 generic provider 只需要一个能按 URL 取静态文件的 HTTP 服务：
 *    GET <base>/latest.yml   读清单比对版本
 *    GET <base>/*.exe        下载安装包（差分时带 Range）
 *    GET <base>/*.blockmap   差分下载的块映射（带 Range，可能是多段）
 *
 *  用法（在仓库根目录，本地联调）:
 *    node scripts/server/server.mjs --root apps/editor/release --port 8788 --base /
 *  生产由 setup.mjs 注册成系统服务后台跑，无需手动调用。
 *
 *  只用 node 内置模块，无第三方依赖。
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, join, normalize, extname, sep } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

function normalizeBase(b) {
  let v = String(b || '/')
  if (!v.startsWith('/')) v = `/${v}`
  if (!v.endsWith('/')) v = `${v}/`
  return v
}

const config = {
  root: resolve(args.root ?? process.env.UE_SERVER_ROOT ?? '.'),
  port: Number(args.port ?? process.env.UE_SERVER_PORT ?? 80),
  host: args.host ?? process.env.UE_SERVER_HOST ?? '0.0.0.0',
  base: normalizeBase(args.base ?? process.env.UE_SERVER_BASE ?? '/universe-editor/'),
}

if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
  die(`--port 非法: ${config.port}`)
}

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
}

function contentType(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

// latest.yml 是清单，必须禁缓存，否则客户端读到旧版本号检测不到更新。
// 下载页 index.html 与 release-notes.json 同理：发布时会变，且版本信息本就来自
// 禁缓存的 latest.yml，统一禁缓存避免浏览器展示旧内容。
function cacheHeaders(file, headers) {
  const ext = extname(file).toLowerCase()
  if (ext === '.yml' || ext === '.yaml' || ext === '.html' || ext === '.json') {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    headers['Pragma'] = 'no-cache'
    headers['Expires'] = '0'
  } else {
    headers['Cache-Control'] = 'public, max-age=86400'
  }
}

function logLine(req, status, extra = '') {
  const ts = new Date().toISOString()
  console.log(`${ts} ${req.method} ${status} ${req.url}${extra ? ` ${extra}` : ''}`)
}

function send(req, res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
  logLine(req, status)
}

// 解析 Range 头，返回规范化后的区间数组（闭区间 [start, end]）。非法返回 null。
function parseRange(rangeHeader, size) {
  const m = /^bytes=(.+)$/.exec(rangeHeader.trim())
  if (!m) return null
  const ranges = []
  for (const part of m[1].split(',')) {
    const seg = part.trim()
    const dash = seg.indexOf('-')
    if (dash < 0) return null
    const rawStart = seg.slice(0, dash).trim()
    const rawEnd = seg.slice(dash + 1).trim()
    let start
    let end
    if (rawStart === '') {
      // 后缀区间 bytes=-N：最后 N 个字节
      if (rawEnd === '') return null
      const n = Number(rawEnd)
      if (!Number.isInteger(n) || n <= 0) return null
      start = Math.max(0, size - n)
      end = size - 1
    } else {
      start = Number(rawStart)
      if (!Number.isInteger(start) || start < 0) return null
      if (rawEnd === '') end = size - 1
      else {
        end = Number(rawEnd)
        if (!Number.isInteger(end) || end < start) return null
      }
      if (end > size - 1) end = size - 1
    }
    if (start > size - 1) return null // 越界
    ranges.push({ start, end })
  }
  return ranges.length ? ranges : null
}

// 多段 Range：multipart/byteranges。用 chunked（不设 Content-Length），逐段顺序 stream。
function sendMultipart(req, res, file, ranges, size, type) {
  const boundary = `UE_BOUNDARY_${size.toString(16)}_${ranges.length}`
  res.writeHead(206, {
    'Content-Type': `multipart/byteranges; boundary=${boundary}`,
    'Accept-Ranges': 'bytes',
  })
  logLine(req, 206, `multipart ${ranges.length} ranges`)

  let i = 0
  const next = () => {
    if (i >= ranges.length) {
      res.end(`\r\n--${boundary}--\r\n`)
      return
    }
    const { start, end } = ranges[i++]
    const header =
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${type}\r\n` +
      `Content-Range: bytes ${start}-${end}/${size}\r\n\r\n`
    res.write(header)
    const stream = createReadStream(file, { start, end })
    stream.on('error', () => res.destroy())
    stream.on('end', next) // 背压：每段写完再下一段
    stream.pipe(res, { end: false })
  }
  next()
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    return send(req, res, 400, 'Bad Request')
  }

  // 根路径给个健康检查响应，方便 curl / 负载均衡探活。
  if (pathname === '/' && config.base !== '/') {
    return send(req, res, 200, 'universe-update-server ok\n')
  }

  if (!pathname.startsWith(config.base)) {
    return send(req, res, 404, 'Not Found')
  }

  const rel = pathname.slice(config.base.length)
  let target = join(config.root, normalize(rel))

  // 路径穿越防护：归一化后必须仍在 root 内。
  if (target !== config.root && !target.startsWith(config.root + sep)) {
    return send(req, res, 403, 'Forbidden')
  }

  let info
  try {
    info = await stat(target)
  } catch {
    return send(req, res, 404, 'Not Found')
  }
  if (info.isDirectory()) {
    // 目录请求回退到 index.html（下载页）；不存在则维持 autoindex off 的 404。
    const indexFile = join(target, 'index.html')
    try {
      const indexInfo = await stat(indexFile)
      if (!indexInfo.isFile()) return send(req, res, 404, 'Not Found')
      target = indexFile
      info = indexInfo
    } catch {
      return send(req, res, 404, 'Not Found')
    }
  }

  const size = info.size
  const type = contentType(target)
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
  cacheHeaders(target, headers)

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': size })
    res.end()
    return logLine(req, 200)
  }

  const rangeHeader = req.headers['range']
  if (!rangeHeader) {
    res.writeHead(200, { ...headers, 'Content-Length': size })
    const stream = createReadStream(target)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return logLine(req, 200)
  }

  const ranges = parseRange(rangeHeader, size)
  if (!ranges) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
    res.end()
    return logLine(req, 416, rangeHeader)
  }

  if (ranges.length === 1) {
    const { start, end } = ranges[0]
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    })
    const stream = createReadStream(target, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return logLine(req, 206, `bytes ${start}-${end}/${size}`)
  }

  return sendMultipart(req, res, target, ranges, size, type)
}

// root 必须存在；不存在时早失败，避免服务起来后所有请求 404 难排查。
try {
  if (!statSync(config.root).isDirectory()) die(`--root 不是目录: ${config.root}`)
} catch {
  die(`--root 不存在: ${config.root}`)
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
    console.error(`\x1b[31m✗ ${req.method} ${req.url}: ${err?.message ?? err}\x1b[0m`)
  })
})

server.on('error', (err) => {
  if (err.code === 'EACCES')
    die(`端口 ${config.port} 需要更高权限（80 端口需 root/管理员或 CAP_NET_BIND_SERVICE）`)
  if (err.code === 'EADDRINUSE') die(`端口 ${config.port} 已被占用`)
  die(`服务器错误: ${err.message}`)
})

server.listen(config.port, config.host, () => {
  console.log(`\n📡 Universe 更新服务器已启动`)
  console.log(`   监听:   http://${config.host}:${config.port}`)
  console.log(`   根目录: ${config.root}`)
  console.log(`   路径段: ${config.base}`)
  console.log(`   node:   ${process.version}\n`)
})

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`\n收到 ${signal}，正在关闭…`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref() // 兜底强退
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
