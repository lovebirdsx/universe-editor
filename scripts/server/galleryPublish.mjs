/*---------------------------------------------------------------------------------------------
 *  市场自助发布 API 的服务端流水线（Phase D）。端点路径与 uex 客户端 packages/uex/src/lib/galleryApi.ts 对齐：
 *
 *    POST gallery/api/publish    Bearer + vsix 二进制流 → 201 { id, version }
 *    POST gallery/api/unpublish  Bearer + JSON { id, version|null } → 200 { removed }
 *    GET  gallery/api/whoami     Bearer → 200 { publisher, status }
 *    POST gallery/api/register   无认证 JSON { publisher, email?, label? } → 201 { publisher, token, label, status }
 *
 *  管理端点（--admin-token-file 配置的管理令牌，独立于 publish token）：
 *
 *    GET  gallery/api/admin/publishers           → 200 [ { name, email, status, created, tokenCount, extensions } ]
 *    POST gallery/api/admin/publishers/approve   { name } → pending → active
 *    POST gallery/api/admin/publishers/reject    { name } → pending → rejected
 *    POST gallery/api/admin/publishers/remove    { name } → 删除 pending/rejected 且名下无扩展的记录
 *
 *  注册审批制：自助注册落 status 'pending'，publish/unpublish 一律 403（whoami 放行便于查进度）；
 *  rejected 与无效 token 不可区分（一律 401，不给探测面）；运维通道 token.mjs 签发直接 active。
 *
 *  防投毒对称另一半：registry 元数据只从服务端亲自解开的 VSIX 里抽取（zod 校验与宿主同一份
 *  schema），客户端声称什么一概不信；版本不可变（409）是供应链安全地基，无例外。
 *
 *  由 server.mjs lazy import 并注入全部外部依赖（createGalleryApi），自身不读进程级配置。
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readVsixManifest } from '@universe-editor/extension-packaging'
import {
  issueToken,
  metadataFromManifest,
  PUBLISHER_MAX_LEN,
  PUBLISHER_RE,
  publisherStatus,
  readVsixEntry,
  removeFromRegistry,
  RESERVED_PUBLISHERS,
  signVsix,
  upsertVersion,
  writeJsonAtomic,
} from '../gallery/lib.mjs'

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

class SizeLimitError extends Error {}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// 服务端重建的市场文件必须保持组可写，否则 scp 发布通道会被自己写出的 644 锁死。
async function makeGroupWritable(dir) {
  if (process.platform === 'win32') return
  await chmod(dir, 0o2775)
  for (const name of await readdir(dir)) {
    const p = join(dir, name)
    const st = await stat(p)
    if (st.isDirectory()) await makeGroupWritable(p)
    else await chmod(p, 0o664)
  }
}

export function createGalleryApi(deps) {
  const {
    galleryRoot,
    authDir,
    maxVsixSize,
    signingKey,
    adminToken = null,
    send,
    logLine,
    readJsonCached,
    invalidateJsonCache,
    readJsonFresh,
    readBody,
    registerRateLimit = 0,
  } = deps
  const registryPath = join(galleryRoot, 'registry.json')
  const publishersPath = join(authDir, 'publishers.json')

  // 写操作进程内串行：registry 是 read-modify-write，并发 publish 会丢更新。
  let queue = Promise.resolve()
  function enqueue(fn) {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  function sendJson(res, status, obj) {
    const json = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    })
    res.end(json)
  }

  // Bearer → sha256 → publishers.json 查归属。401 一律不区分原因（不给探测面）。
  // 命中返回 { name, status }；status 经 publisherStatus 归一（缺省 active，审批制门控）。
  // 认证数据直读不走 mtime 缓存：令牌吊销/恢复必须即时生效（Windows 快速连续写 mtime
  // 可能不变，缓存会误命中旧内容，见 server.mjs readJsonFresh）。
  function authenticate(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length).trim()
    if (!token) return null
    const hash = createHash('sha256').update(token).digest()
    const data = readJsonFresh(publishersPath, { publishers: [] })
    for (const p of data.publishers ?? []) {
      for (const t of p.tokens ?? []) {
        if (t.revoked) continue
        const stored = Buffer.from(String(t.hash ?? ''), 'hex')
        if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
          return { name: p.name, status: publisherStatus(p) }
        }
      }
    }
    return null
  }

  // 写操作（publish/unpublish）的审批门控：pending 告知在等审批（403，作者能看懂）；
  // rejected 一律 401（与无效 token 不可区分，不给探测面）。
  function requireActive(auth) {
    if (auth.status === 'pending') {
      throw new ApiError(
        403,
        `publisher "${auth.name}" is pending approval — publishing is enabled after an admin approves the registration`,
      )
    }
    if (auth.status === 'rejected') throw new ApiError(401, 'unauthorized')
  }

  // 管理令牌（--admin-token-file 注入）：与 publish token 独立的一套凭证。
  // 未配置时管理面整体 503（fail-closed，同签名密钥语义）；配置了则比对 sha256。
  const adminTokenHash = adminToken ? createHash('sha256').update(adminToken).digest() : null
  function adminAuthorized(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const token = header.slice('Bearer '.length).trim()
    if (!token) return false
    const hash = createHash('sha256').update(token).digest()
    return hash.length === adminTokenHash.length && timingSafeEqual(hash, adminTokenHash)
  }

  function requireAdmin(req) {
    if (!adminTokenHash) {
      throw new ApiError(503, 'admin console is disabled — configure --admin-token-file')
    }
    if (!adminAuthorized(req)) throw new ApiError(401, 'unauthorized')
  }

  // 注册 IP 节流：内存级滑动窗口（1 小时），懒清理过期记录。
  // 进程重启即清零——防的是脚本批量占名，不需要持久化精度；0 = 关闭。
  const registerHits = new Map() // ip → 时间戳（ms）数组
  function registerLimited(ip) {
    if (!registerRateLimit) return false
    const now = Date.now()
    const floor = now - 3_600_000
    const hits = (registerHits.get(ip) ?? []).filter((t) => t > floor)
    if (hits.length >= registerRateLimit) {
      registerHits.set(ip, hits)
      return true
    }
    hits.push(now)
    registerHits.set(ip, hits)
    return false
  }

  // publisher 自助注册：无认证（注册即签发首个 token），按 IP 节流。
  async function register(req, res) {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      throw new ApiError(400, 'invalid JSON body')
    }
    // 节流判在进串行队列之前：占名脚本不该占用写队列
    if (registerLimited(req.socket.remoteAddress ?? 'unknown')) {
      throw new ApiError(429, 'too many registration attempts from this IP — try again later')
    }
    const publisher = body?.publisher
    if (typeof publisher !== 'string' || !publisher) {
      throw new ApiError(400, '"publisher" is required')
    }
    if (publisher.length > PUBLISHER_MAX_LEN) {
      throw new ApiError(400, `"publisher" must be at most ${PUBLISHER_MAX_LEN} characters`)
    }
    if (!PUBLISHER_RE.test(publisher)) {
      throw new ApiError(
        400,
        '"publisher" must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, hyphens; no leading hyphen)',
      )
    }
    if (RESERVED_PUBLISHERS.has(publisher)) {
      throw new ApiError(400, `"publisher" "${publisher}" is reserved`)
    }
    let email
    if (body?.email !== undefined && body.email !== null && body.email !== '') {
      if (typeof body.email !== 'string' || body.email.length > 254 || !EMAIL_RE.test(body.email)) {
        throw new ApiError(400, '"email" must be a valid email address (at most 254 characters)')
      }
      email = body.email
    }
    let label = body?.label
    if (label === undefined || label === null || label === '') label = 'web-register'
    if (typeof label !== 'string' || label.length > 64) {
      throw new ApiError(400, '"label" must be a non-empty string of at most 64 characters')
    }

    await enqueue(async () => {
      // 与 publish 处理 registry 同一约定：直接改读入的对象，写盘后显式失效。
      // 认证数据一律直读（readJsonFresh）：外部改文件（吊销/恢复）必须即时生效，
      // mtime 缓存在 Windows 快速连续写下会误命中旧内容（见 server.mjs readJsonFresh）。
      const data = readJsonFresh(publishersPath, { publishers: [] })
      if (!Array.isArray(data.publishers)) data.publishers = []
      // 已存在一律 409，不区分原因（不给占名探测面；含潜在的 label 冲突场景）
      if (data.publishers.some((p) => p.name === publisher)) {
        throw new ApiError(409, 'publisher name is taken')
      }
      // 审批制：自助注册落 pending，管理端 approve 后才能 publish（token 照常签发，先可 whoami）
      const { token } = issueToken(data, publisher, label, { status: 'pending' })
      if (email !== undefined) {
        data.publishers.find((p) => p.name === publisher).email = email
      }
      writeJsonAtomic(publishersPath, data)
      invalidateJsonCache(publishersPath)
      logLine(req, 201, `register ${publisher} (pending)`)
      sendJson(res, 201, { publisher, token, label, status: 'pending' })
    })
  }

  // 流式落盘，边写边计体积（不整包进内存）。超限中断并清理。
  async function streamUpload(req, dest) {
    let size = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        if (size > maxVsixSize) cb(new SizeLimitError('vsix too large'))
        else cb(null, chunk)
      },
    })
    try {
      await pipeline(req, counter, createWriteStream(dest))
    } catch (err) {
      await rm(dest, { force: true }).catch(() => {})
      if (err instanceof SizeLimitError) {
        throw new ApiError(413, `vsix exceeds the ${maxVsixSize}-byte upload limit`)
      }
      throw err
    }
  }

  async function publish(req, res) {
    const auth = authenticate(req)
    if (!auth) throw new ApiError(401, 'unauthorized')
    requireActive(auth)
    const publisher = auth.name
    // 编辑器验签 fail-closed：服务端无签名能力时上架的包必然拒装，直接在入口处拒绝。
    // 判在 401 之后：不经验证的请求连服务端配置面都不该探到。
    if (!signingKey) {
      throw new ApiError(
        503,
        'server is not configured with a signing key — contact the marketplace operator',
      )
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxVsixSize) {
      throw new ApiError(413, `vsix exceeds the ${maxVsixSize}-byte upload limit`)
    }
    const tmpVsix = join(tmpdir(), `upload-${randomUUID()}.vsix`)
    try {
      await streamUpload(req, tmpVsix)

      // ③ 亲自读包：zod 校验（与宿主同一份 schema）+ 市场强校验（publisher 必填）。
      let manifest
      try {
        manifest = readVsixManifest(tmpVsix)
      } catch (err) {
        throw new ApiError(400, `invalid vsix: ${err?.message ?? err}`)
      }
      let meta
      try {
        meta = metadataFromManifest(manifest)
      } catch (err) {
        throw new ApiError(400, err?.message ?? String(err))
      }
      // ④ 归属校验
      if (meta.publisher !== publisher) {
        throw new ApiError(
          403,
          `manifest publisher "${meta.publisher}" does not match the token's publisher "${publisher}"`,
        )
      }
      const id = `${meta.publisher}.${meta.name}`

      await enqueue(async () => {
        // ⑤ 版本不可变
        const registry = readJsonCached(registryPath, { extensions: [] })
        if (!Array.isArray(registry.extensions)) registry.extensions = []
        const existing = registry.extensions.find(
          (e) => e.publisher === meta.publisher && e.name === meta.name,
        )
        if (existing?.versions?.some((v) => v.version === meta.version)) {
          throw new ApiError(
            409,
            `${id}@${meta.version} already exists — versions are immutable, bump "version" and publish again`,
          )
        }

        // ⑥ 落资产：staging 写完原子 rename。zip entry 名一律 basename 化后才落地，
        // 路径从不由包内名字拼接（zip-slip 免疫）。
        const assetDir = `assets/${id}/${meta.version}`
        const staging = join(galleryRoot, 'assets', `.staging-${randomUUID()}`)
        try {
          await mkdir(staging, { recursive: true })
          const vsixName = `${id}-${meta.version}.vsix`
          await copyFile(tmpVsix, join(staging, vsixName))
          const files = { vsix: vsixName }
          if (meta.iconRel) {
            const iconBuf = readVsixEntry(tmpVsix, meta.iconRel)
            if (iconBuf) {
              const iconName = basename(meta.iconRel)
              await writeFile(join(staging, iconName), iconBuf)
              files.icon = iconName
            }
          }
          for (const [rel, key] of [
            ['README.md', 'readme'],
            ['CHANGELOG.md', 'changelog'],
          ]) {
            const buf = readVsixEntry(tmpVsix, rel)
            if (buf) {
              await writeFile(join(staging, rel), buf)
              files[key] = rel
            }
          }

          const versionEntry = {
            version: meta.version,
            lastUpdated: new Date().toISOString(),
            engine: meta.engine,
            assetDir,
            files,
            // 签 staging 内的规范名落盘文件——客户端下载的就是这份字节（与运维通道 publish.mjs 同约定）
            ...signVsix(join(staging, vsixName), signingKey),
          }
          // ⑦ 先 assets 后 registry 的既有原子约定
          const finalDir = join(galleryRoot, assetDir)
          await rm(finalDir, { recursive: true, force: true }) // 只可能来自上次崩溃残留（registry 无此版本）
          await mkdir(join(galleryRoot, 'assets', id), { recursive: true })
          // 目录可能是 scp 通道（发布用户）先建的，非属主 chmod 会 EPERM，只做 best-effort
          if (process.platform !== 'win32') {
            await chmod(join(galleryRoot, 'assets', id), 0o2775).catch(() => {})
          }
          await makeGroupWritable(staging)
          await rename(staging, finalDir)
          upsertVersion(registry, meta, versionEntry)
          writeJsonAtomic(registryPath, registry, { mode: 0o664 })
          invalidateJsonCache(registryPath)
        } catch (err) {
          await rm(staging, { recursive: true, force: true }).catch(() => {})
          throw err
        }

        // ⑧ 审计：日志即内部阶段的审计面
        logLine(req, 201, `publish ${id}@${meta.version} by ${publisher}`)
        sendJson(res, 201, { id, version: meta.version })
      })
    } finally {
      await rm(tmpVsix, { force: true }).catch(() => {})
    }
  }

  async function unpublish(req, res) {
    const auth = authenticate(req)
    if (!auth) throw new ApiError(401, 'unauthorized')
    requireActive(auth)
    const publisher = auth.name
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      throw new ApiError(400, 'invalid JSON body')
    }
    const id = String(body?.id ?? '')
    const version =
      body?.version === null || body?.version === undefined ? null : String(body.version)
    const dot = id.indexOf('.')
    if (dot <= 0 || dot === id.length - 1) {
      throw new ApiError(400, '"id" must be <publisher>.<name>')
    }
    const name = id.slice(dot + 1)
    if (id.slice(0, dot) !== publisher) {
      throw new ApiError(403, `token publisher "${publisher}" cannot unpublish "${id}"`)
    }
    const label = version ? `${id}@${version}` : id

    await enqueue(async () => {
      const registry = readJsonCached(registryPath, { extensions: [] })
      if (!Array.isArray(registry.extensions)) registry.extensions = []
      const { removedAssetDirs, found } = removeFromRegistry(
        registry,
        publisher,
        name,
        version ?? undefined,
      )
      if (!found) throw new ApiError(404, `${label} not found`)
      writeJsonAtomic(registryPath, registry, { mode: 0o664 })
      invalidateJsonCache(registryPath)
      for (const dir of removedAssetDirs) {
        const target = resolve(galleryRoot, dir)
        if (target === galleryRoot || !target.startsWith(galleryRoot + sep)) continue
        await rm(target, { recursive: true, force: true })
        // 父目录（assets/<id>）空则顺手收掉，不留空壳（非空时报 ENOTEMPTY，忽略）
        await rmdir(dirname(target)).catch(() => {})
      }
      logLine(req, 200, `unpublish ${label} by ${publisher}`)
      sendJson(res, 200, { removed: label })
    })
  }

  /*--------------------------------- 管理端点（审批制） ---------------------------------*/

  // publisher 列表 + registry 汇总（每行的 extensions 是该名下已上架的扩展 id）。
  function listPublishers(req, res) {
    const data = readJsonFresh(publishersPath, { publishers: [] })
    const registry = readJsonCached(registryPath, { extensions: [] })
    const extByPublisher = new Map()
    for (const e of registry.extensions ?? []) {
      if (!e?.publisher || !e?.name) continue
      const list = extByPublisher.get(e.publisher) ?? []
      list.push(`${e.publisher}.${e.name}`)
      extByPublisher.set(e.publisher, list)
    }
    const publishers = (data.publishers ?? []).map((p) => ({
      name: p.name,
      email: p.email ?? null,
      status: publisherStatus(p),
      created: p.created ?? null,
      tokenCount: (p.tokens ?? []).filter((t) => !t.revoked).length,
      extensions: extByPublisher.get(p.name) ?? [],
    }))
    logLine(req, 200, `admin list ${publishers.length} publishers`)
    sendJson(res, 200, { publishers })
  }

  async function readAdminName(req) {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      throw new ApiError(400, 'invalid JSON body')
    }
    const name = body?.name
    if (typeof name !== 'string' || !name) throw new ApiError(400, '"name" is required')
    return name
  }

  // approve / reject 共用：仅 pending 可翻转，其余一律 409。
  async function setPublisherStatus(req, res, action, target) {
    const name = await readAdminName(req)
    await enqueue(async () => {
      const data = readJsonFresh(publishersPath, { publishers: [] })
      const entry = (data.publishers ?? []).find((p) => p.name === name)
      if (!entry) throw new ApiError(404, `publisher "${name}" not found`)
      if (publisherStatus(entry) !== 'pending') {
        throw new ApiError(409, `publisher "${name}" is not pending approval`)
      }
      entry.status = target
      writeJsonAtomic(publishersPath, data)
      invalidateJsonCache(publishersPath)
      logLine(req, 200, `admin ${action} ${name}`)
      sendJson(res, 200, { publisher: name, status: target })
    })
  }

  // 仅允许删除 pending/rejected 且名下无扩展的记录（释放名字）；active 或有扩展一律 409。
  async function removePublisher(req, res) {
    const name = await readAdminName(req)
    await enqueue(async () => {
      const data = readJsonFresh(publishersPath, { publishers: [] })
      if (!Array.isArray(data.publishers)) data.publishers = []
      const entry = data.publishers.find((p) => p.name === name)
      if (!entry) throw new ApiError(404, `publisher "${name}" not found`)
      const status = publisherStatus(entry)
      if (status !== 'pending' && status !== 'rejected') {
        throw new ApiError(
          409,
          `publisher "${name}" is active — only pending/rejected records can be removed`,
        )
      }
      const registry = readJsonCached(registryPath, { extensions: [] })
      if ((registry.extensions ?? []).some((e) => e.publisher === name)) {
        throw new ApiError(409, `publisher "${name}" still owns extensions — unpublish them first`)
      }
      data.publishers.splice(data.publishers.indexOf(entry), 1)
      writeJsonAtomic(publishersPath, data)
      invalidateJsonCache(publishersPath)
      logLine(req, 200, `admin remove ${name}`)
      sendJson(res, 200, { removed: name })
    })
  }

  return {
    async handle(req, res, rel) {
      try {
        switch (rel) {
          case 'gallery/api/whoami': {
            const auth = authenticate(req)
            if (!auth) throw new ApiError(401, 'unauthorized')
            // rejected 与无效 token 不可区分（401）；pending 放行——作者靠 whoami 查审批进度
            if (auth.status === 'rejected') throw new ApiError(401, 'unauthorized')
            logLine(req, 200, `whoami ${auth.name} (${auth.status})`)
            sendJson(res, 200, { publisher: auth.name, status: auth.status })
            return true
          }
          case 'gallery/api/publish':
            await publish(req, res)
            return true
          case 'gallery/api/unpublish':
            await unpublish(req, res)
            return true
          case 'gallery/api/register':
            await register(req, res)
            return true
          case 'gallery/api/admin/publishers':
            requireAdmin(req)
            listPublishers(req, res)
            return true
          case 'gallery/api/admin/publishers/approve':
            requireAdmin(req)
            await setPublisherStatus(req, res, 'approve', 'active')
            return true
          case 'gallery/api/admin/publishers/reject':
            requireAdmin(req)
            await setPublisherStatus(req, res, 'reject', 'rejected')
            return true
          case 'gallery/api/admin/publishers/remove':
            requireAdmin(req)
            await removePublisher(req, res)
            return true
          default:
            return false
        }
      } catch (err) {
        if (err instanceof ApiError) {
          send(req, res, err.status, err.message)
          return true
        }
        throw err
      }
    },
  }
}
