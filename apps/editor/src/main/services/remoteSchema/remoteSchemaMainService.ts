/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Downloads remote JSON schemas and caches them under
 *  `<userData>/json-schema-cache/`. Mirrors VSCode's schema download: ETag
 *  revalidation, a TTL that avoids hitting the network on every startup, and a
 *  stale-cache fallback so an offline launch still gets completion. Pure
 *  downloader — enable/trust policy lives in the renderer.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  IRemoteSchemaService,
  RemoteSchemaResult,
} from '../../../shared/ipc/remoteSchemaService.js'

interface CacheEntry {
  url: string
  etag?: string
  content: string
  fetchedAt: number
}

/** Skip the network when a cache entry is younger than this (mirrors VSCode's schemastore optimization). */
const TTL_MS = 12 * 60 * 60 * 1000

export class RemoteSchemaMainService extends Disposable implements IRemoteSchemaService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _mem = new Map<string, CacheEntry>()

  constructor(
    private readonly _cacheDir: string = join(app.getPath('userData'), 'json-schema-cache'),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'remoteSchema', name: 'Remote Schema' })
  }

  async fetchSchema(url: string): Promise<RemoteSchemaResult> {
    const cached = await this._readCache(url)
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      return { ok: true, content: cached.content }
    }

    try {
      const headers: Record<string, string> = {}
      if (cached?.etag) headers['If-None-Match'] = cached.etag
      const res = await fetch(url, { headers, redirect: 'follow' })

      if (res.status === 304 && cached) {
        await this._touch(url, cached)
        return { ok: true, content: cached.content }
      }
      if (!res.ok) {
        if (cached) return { ok: true, content: cached.content } // stale fallback
        return { ok: false, error: `HTTP ${res.status}` }
      }

      const content = await res.text()
      // Validate it parses before caching — a captive-portal HTML page is not a schema.
      JSON.parse(content)
      const entry: CacheEntry = {
        url,
        content,
        fetchedAt: Date.now(),
        ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}),
      }
      await this._writeCache(url, entry)
      return { ok: true, content }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (cached) {
        this._logger.warn(`fetch ${url} failed (${message}); serving cached copy`)
        return { ok: true, content: cached.content }
      }
      this._logger.warn(`fetch ${url} failed: ${message}`)
      return { ok: false, error: message }
    }
  }

  private _cacheFile(url: string): string {
    const hash = createHash('sha256').update(url).digest('hex')
    return join(this._cacheDir, `${hash}.json`)
  }

  private async _readCache(url: string): Promise<CacheEntry | undefined> {
    const mem = this._mem.get(url)
    if (mem) return mem
    try {
      const raw = await fs.readFile(this._cacheFile(url), 'utf8')
      const entry = JSON.parse(raw) as CacheEntry
      this._mem.set(url, entry)
      return entry
    } catch {
      return undefined
    }
  }

  private async _writeCache(url: string, entry: CacheEntry): Promise<void> {
    this._mem.set(url, entry)
    try {
      await fs.mkdir(this._cacheDir, { recursive: true })
      await fs.writeFile(this._cacheFile(url), JSON.stringify(entry), 'utf8')
    } catch (err) {
      this._logger.warn(`cache write failed for ${url}: ${String(err)}`)
    }
  }

  /** Refresh fetchedAt after a 304 so the TTL window restarts. */
  private async _touch(url: string, cached: CacheEntry): Promise<void> {
    await this._writeCache(url, { ...cached, fetchedAt: Date.now() })
  }
}
