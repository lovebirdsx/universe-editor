/*---------------------------------------------------------------------------------------------
 *  市场自助发布 API 的服务端流水线（Phase D，见 docs/plan/third-party-extension-ecosystem-plan/
 *  04-publishing-backend.md）。端点路径与 uex 客户端 packages/uex/src/lib/galleryApi.ts 对齐：
 *
 *    POST gallery/api/publish    Bearer + vsix 二进制流 → 201 { id, version }
 *    POST gallery/api/unpublish  Bearer + JSON { id, version|null } → 200 { removed }
 *    GET  gallery/api/whoami     Bearer → 200 { publisher }
 *
 *  防投毒对称另一半：registry 元数据只从服务端亲自解开的 VSIX 里抽取（zod 校验与宿主同一份
 *  schema），客户端声称什么一概不信；版本不可变（409）是供应链安全地基，无例外。
 *
 *  由 server.mjs lazy import 并注入全部外部依赖（createGalleryApi），自身不读进程级配置。
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readVsixManifest } from '@universe-editor/extension-packaging'
import {
  metadataFromManifest,
  readVsixEntry,
  removeFromRegistry,
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

export function createGalleryApi(deps) {
  const { galleryRoot, authDir, maxVsixSize, send, logLine, readJsonCached, invalidateJsonCache, readBody } =
    deps
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
  function authenticate(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length).trim()
    if (!token) return null
    const hash = createHash('sha256').update(token).digest()
    const data = readJsonCached(publishersPath, { publishers: [] })
    for (const p of data.publishers ?? []) {
      for (const t of p.tokens ?? []) {
        if (t.revoked) continue
        const stored = Buffer.from(String(t.hash ?? ''), 'hex')
        if (stored.length === hash.length && timingSafeEqual(stored, hash)) return p.name
      }
    }
    return null
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
    const publisher = authenticate(req)
    if (!publisher) throw new ApiError(401, 'unauthorized')
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
          }
          // ⑦ 先 assets 后 registry 的既有原子约定
          const finalDir = join(galleryRoot, assetDir)
          await rm(finalDir, { recursive: true, force: true }) // 只可能来自上次崩溃残留（registry 无此版本）
          await mkdir(join(galleryRoot, 'assets', id), { recursive: true })
          await rename(staging, finalDir)
          upsertVersion(registry, meta, versionEntry)
          writeJsonAtomic(registryPath, registry)
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
    const publisher = authenticate(req)
    if (!publisher) throw new ApiError(401, 'unauthorized')
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      throw new ApiError(400, 'invalid JSON body')
    }
    const id = String(body?.id ?? '')
    const version = body?.version === null || body?.version === undefined ? null : String(body.version)
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
      writeJsonAtomic(registryPath, registry)
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

  return {
    async handle(req, res, rel) {
      try {
        switch (rel) {
          case 'gallery/api/whoami': {
            const publisher = authenticate(req)
            if (!publisher) throw new ApiError(401, 'unauthorized')
            logLine(req, 200, `whoami ${publisher}`)
            sendJson(res, 200, { publisher })
            return true
          }
          case 'gallery/api/publish':
            await publish(req, res)
            return true
          case 'gallery/api/unpublish':
            await unpublish(req, res)
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
