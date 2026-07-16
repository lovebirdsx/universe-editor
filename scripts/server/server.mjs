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
import { createReadStream, statSync, readFileSync } from 'node:fs'
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

const root = resolve(args.root ?? process.env.UE_SERVER_ROOT ?? '.')
const config = {
  root,
  // 市场内容根（含 registry.json / control.json / assets/**）。与更新根解耦：
  // 默认 <root>/gallery（合并部署零配置），可用 --gallery-root 指向独立目录/磁盘。
  galleryRoot: resolve(
    args['gallery-root'] ?? process.env.UE_SERVER_GALLERY_ROOT ?? join(root, 'gallery'),
  ),
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
  '.vsix': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
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

/*--------------------------------- 扩展市场（gallery） ---------------------------------*/
//
// 客户端（extension-gallery 包）对齐 VSCode / open-vsx 的 /extensionquery 协议。本服务器
// 用一份静态 <root>/gallery/registry.json 在内存里过滤/排序/分页，生成协议响应——零依赖、
// 无数据库。VSIX / 图标 / README 是 <root>/gallery/assets/** 下的静态文件，走既有静态服务。
// 契约细节见 docs/development/marketplace-server.md。

// 与 extension-gallery/protocol.ts 的常量保持一致（客户端解析依赖这些字符串）。
const ASSET_VSIX = 'Microsoft.VisualStudio.Services.VSIXPackage'
const ASSET_ICON = 'Microsoft.VisualStudio.Services.Icons.Default'
const ASSET_README = 'Microsoft.VisualStudio.Services.Content.Details'
const ASSET_CHANGELOG = 'Microsoft.VisualStudio.Services.Content.Changelog'
const ENGINE_KEY = 'Universe.Editor.Engine'

// filterType（子集，与客户端一致）
const FILTER_CATEGORY = 5
const FILTER_EXTENSION_NAME = 7
const FILTER_TARGET = 8
const FILTER_SEARCH_TEXT = 10
// sortBy
const SORT_INSTALL_COUNT = 4
const SORT_RATING = 6
const SORT_UPDATED = 10
// flags
const FLAG_LATEST_VERSION_ONLY = 0x200

function galleryRoot() {
  return config.galleryRoot
}

// registry.json / control.json 带 mtime 缓存：改文件自动重载，无需重启服务。读失败返回兜底值。
const jsonCache = new Map() // path → { mtimeMs, value }
function readJsonCached(file, fallback) {
  let mtimeMs
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return fallback
  }
  const hit = jsonCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.value
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    jsonCache.set(file, { mtimeMs, value })
    return value
  } catch (err) {
    console.error(`\x1b[33m⚠ 解析失败 ${file}: ${err?.message ?? err}\x1b[0m`)
    return fallback
  }
}

function loadRegistry() {
  const reg = readJsonCached(join(galleryRoot(), 'registry.json'), { extensions: [] })
  return Array.isArray(reg?.extensions) ? reg.extensions : []
}

function loadControlManifest() {
  return readJsonCached(join(galleryRoot(), 'control.json'), { malicious: [], deprecated: {} })
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 一次请求解析出的查询条件。
function parseCriteria(filter) {
  const out = { text: '', names: [], categories: [], targets: [] }
  for (const c of filter?.criteria ?? []) {
    const value = String(c?.value ?? '')
    switch (c?.filterType) {
      case FILTER_SEARCH_TEXT:
        out.text = value.toLowerCase()
        break
      case FILTER_EXTENSION_NAME:
        out.names.push(value.toLowerCase())
        break
      case FILTER_CATEGORY:
        out.categories.push(value.toLowerCase())
        break
      case FILTER_TARGET:
        out.targets.push(value)
        break
      default:
        break
    }
  }
  return out
}

function extIdentifier(ext) {
  return `${ext.publisher}.${ext.name}`.toLowerCase()
}

function matchesExtension(ext, q) {
  if (q.names.length && !q.names.includes(extIdentifier(ext))) return false
  if (q.categories.length) {
    const cats = (ext.categories ?? []).map((c) => String(c).toLowerCase())
    if (!q.categories.some((c) => cats.includes(c))) return false
  }
  if (q.text) {
    const hay = `${ext.displayName ?? ''} ${ext.name ?? ''} ${ext.shortDescription ?? ''} ${
      ext.publisher ?? ''
    }`.toLowerCase()
    if (!hay.includes(q.text)) return false
  }
  return true
}

function latestVersion(ext) {
  return ext.versions?.[0]
}

function statValue(version, ext, key) {
  const v = version?.[key]
  if (typeof v === 'number') return v
  const e = ext?.[key]
  return typeof e === 'number' ? e : 0
}

function sortExtensions(list, sortBy, sortOrder) {
  if (!sortBy) return list // 0 = Relevance：保持 registry 原序
  const dir = sortOrder === 1 ? 1 : -1 // 1=升序，其余（含 0/2）默认降序
  const key = {
    [SORT_INSTALL_COUNT]: 'installCount',
    [SORT_RATING]: 'rating',
  }[sortBy]
  const sorted = [...list]
  sorted.sort((a, b) => {
    const va = latestVersion(a)
    const vb = latestVersion(b)
    if (sortBy === SORT_UPDATED) {
      const ta = Date.parse(va?.lastUpdated ?? '') || 0
      const tb = Date.parse(vb?.lastUpdated ?? '') || 0
      return (ta - tb) * dir
    }
    return (statValue(va, a, key) - statValue(vb, b, key)) * dir
  })
  return sorted
}

// 把 registry 里一个 version 映射成协议的 raw version（files[] 用绝对 URL）。
function toRawVersion(ext, version, assetBase) {
  const dir = version.assetDir ? `${assetBase}/${version.assetDir.replace(/^\/+|\/+$/g, '')}` : ''
  const files = []
  const f = version.files ?? {}
  const push = (assetType, name) => {
    if (name) files.push({ assetType, source: `${dir}/${name}` })
  }
  push(ASSET_VSIX, f.vsix)
  push(ASSET_ICON, f.icon)
  push(ASSET_README, f.readme)
  push(ASSET_CHANGELOG, f.changelog)
  const properties = []
  if (version.engine) properties.push({ key: ENGINE_KEY, value: version.engine })
  return {
    version: version.version,
    ...(version.lastUpdated ? { lastUpdated: version.lastUpdated } : {}),
    files,
    properties,
  }
}

function toRawExtension(ext, latestOnly, assetBase) {
  const versions = latestOnly ? ext.versions.slice(0, 1) : ext.versions
  const statistics = []
  const latest = latestVersion(ext)
  const install = statValue(latest, ext, 'installCount')
  const rating = statValue(latest, ext, 'rating')
  const ratingCount = statValue(latest, ext, 'ratingCount')
  if (install) statistics.push({ statisticName: 'install', value: install })
  if (rating) statistics.push({ statisticName: 'averagerating', value: rating })
  if (ratingCount) statistics.push({ statisticName: 'ratingcount', value: ratingCount })
  return {
    extensionName: ext.name,
    displayName: ext.displayName ?? ext.name,
    shortDescription: ext.shortDescription ?? '',
    publisher: {
      publisherName: ext.publisher,
      ...(ext.publisherDisplayName ? { displayName: ext.publisherDisplayName } : {}),
    },
    versions: versions.map((v) => toRawVersion(ext, v, assetBase)),
    ...(statistics.length ? { statistics } : {}),
    ...(ext.categories ? { categories: ext.categories } : {}),
    ...(ext.uuid ? { extensionId: ext.uuid } : {}),
  }
}

// 从请求构造 /extensionquery 响应。assetBase 是资产 URL 前缀（含 origin + base + gallery）。
function buildQueryResponse(body, assetBase) {
  const filter = body?.filters?.[0] ?? {}
  const q = parseCriteria(filter)
  const flags = Number(body?.flags ?? 0)
  const latestOnly = (flags & FLAG_LATEST_VERSION_ONLY) !== 0
  const pageNumber = Math.max(1, Number(filter.pageNumber) || 1)
  const pageSize = Math.min(1000, Math.max(1, Number(filter.pageSize) || 50))

  const all = loadRegistry().filter(
    (ext) => ext?.publisher && ext?.name && ext.versions?.length && matchesExtension(ext, q),
  )
  const sorted = sortExtensions(all, Number(filter.sortBy) || 0, Number(filter.sortOrder) || 0)
  const total = sorted.length
  const start = (pageNumber - 1) * pageSize
  const page = sorted.slice(start, start + pageSize)

  return {
    results: [
      {
        extensions: page.map((ext) => toRawExtension(ext, latestOnly, assetBase)),
        resultMetadata: [
          { metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: total }] },
        ],
      },
    ],
  }
}

function requestOrigin(req) {
  const proto =
    String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim() || 'http'
  const host = req.headers['host'] ?? `localhost:${config.port}`
  return `${proto}://${host}`
}

// 处理市场端点。命中返回 true（已响应），否则 false（交回静态文件处理）。
async function handleGallery(req, res, pathname) {
  const rel = pathname.slice(config.base.length) // base 命中后的相对路径

  if (rel === 'extensionquery') {
    if (req.method !== 'POST') return false // 静态处理会给 405/404
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      send(req, res, 400, 'Bad Request')
      return true
    }
    // assetBase 指向 gallery 根，registry 里 assetDir 相对它拼接。
    const assetBase = `${requestOrigin(req)}${config.base}gallery`
    let payload
    try {
      payload = buildQueryResponse(body, assetBase)
    } catch (err) {
      console.error(`\x1b[33m⚠ extensionquery 失败: ${err?.message ?? err}\x1b[0m`)
      payload = { results: [{ extensions: [], resultMetadata: [] }] }
    }
    const json = JSON.stringify(payload)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    })
    res.end(json)
    logLine(req, 200, `extensionquery ${payload.results[0].extensions.length} hits`)
    return true
  }

  if (rel === 'control.json') {
    const json = JSON.stringify(loadControlManifest())
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    })
    res.end(json)
    return (logLine(req, 200, 'control.json'), true)
  }

  return false
}

async function handle(req, res) {
  // 市场端点先于方法/静态判定：/extensionquery 用 POST，与静态服务的 GET/HEAD 限制冲突。
  if (req.url) {
    let p
    try {
      p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      return send(req, res, 400, 'Bad Request')
    }
    if (p.startsWith(config.base) && (await handleGallery(req, res, p))) return
  }

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

  // gallery/** 走市场根（与更新根解耦）；其余走更新根。各自做穿越防护。
  const GALLERY_URL_PREFIX = 'gallery/'
  let baseDir
  let relInBase
  if (rel === 'gallery' || rel.startsWith(GALLERY_URL_PREFIX)) {
    baseDir = config.galleryRoot
    relInBase = rel === 'gallery' ? '' : rel.slice(GALLERY_URL_PREFIX.length)
  } else {
    baseDir = config.root
    relInBase = rel
  }
  let target = join(baseDir, normalize(relInBase))

  // 路径穿越防护：归一化后必须仍在对应 base 目录内。
  if (target !== baseDir && !target.startsWith(baseDir + sep)) {
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
  console.log(`   更新根: ${config.root}`)
  const galleryExists = (() => {
    try {
      return statSync(config.galleryRoot).isDirectory()
    } catch {
      return false
    }
  })()
  console.log(
    `   市场根: ${config.galleryRoot}${galleryExists ? '' : ' (暂不存在，市场搜索将为空)'}`,
  )
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
