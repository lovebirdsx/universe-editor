/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process extension marketplace client. Speaks the `/extensionquery` POST
 *  protocol (VSCode / open-vsx compatible), downloads VSIX packages into an
 *  on-disk cache, fetches README text, and keeps a cached control manifest.
 *  Protocol encode/decode is the pure `@universe-editor/extension-gallery` package;
 *  this class is just network + cache + policy. Mirrors VSCode's
 *  `IExtensionGalleryService`. The marketplace address comes from GALLERY_URL —
 *  empty ⇒ disabled (OSS semantics; already-installed extensions still work).
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  createNamedLogger,
  Disposable,
  ILoggerService,
  type ILogger,
} from '@universe-editor/platform'
import {
  buildQuery,
  parseQueryResult,
  type IGalleryExtension,
  type IGalleryQueryResult,
  type IQueryOptions,
  type IRawGalleryQueryResult,
} from '@universe-editor/extension-gallery'
import { IEnvironmentMainService } from '../../environment/environmentMainService.js'
import type {
  IExtensionControlManifest,
  IExtensionGalleryService,
} from '../../../shared/ipc/extensionGalleryService.js'

const API_VERSION = '3.0-preview.1'
const QUERY_ACCEPT = `application/json;api-version=${API_VERSION}`
/** Control manifest revalidated at most this often. */
const CONTROL_TTL_MS = 6 * 60 * 60 * 1000
const EMPTY_CONTROL: IExtensionControlManifest = { malicious: [], deprecated: {} }

/** Minimal view of EnvironmentMainService needed here; keeps the unit test light. */
export interface IGalleryEnvironment {
  readonly galleryUrl: string | undefined
}

interface IControlCache {
  manifest: IExtensionControlManifest
  fetchedAt: number
}

export class ExtensionGalleryMainService extends Disposable implements IExtensionGalleryService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private _controlCache: IControlCache | undefined
  private _readmeCache = new Map<string, string>()
  private _iconCache = new Map<string, string>()

  constructor(
    @IEnvironmentMainService private readonly _environment: IGalleryEnvironment,
    private readonly _cacheDir: string = join(app.getPath('userData'), 'CachedExtensionVSIXs'),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'extensionGallery',
      name: 'Extension Gallery',
    })
  }

  private get _galleryUrl(): string | undefined {
    const url = this._environment.galleryUrl
    return url ? url.replace(/\/+$/, '') : undefined
  }

  async isEnabled(): Promise<boolean> {
    return this._galleryUrl !== undefined
  }

  async query(options: IQueryOptions): Promise<IGalleryQueryResult> {
    const base = this._galleryUrl
    if (!base) return { extensions: [], total: 0 }

    try {
      const raw = await this._postQuery(base, buildQuery(options))
      return parseQueryResult(raw)
    } catch (err) {
      this._logger.warn(`query failed: ${(err as Error).message}`)
      return { extensions: [], total: 0 }
    }
  }

  async getExtensions(ids: readonly string[]): Promise<IGalleryExtension[]> {
    const base = this._galleryUrl
    if (!base || ids.length === 0) return []

    try {
      const raw = await this._postQuery(base, buildQuery({ names: [...ids], pageSize: ids.length }))
      return parseQueryResult(raw).extensions
    } catch (err) {
      this._logger.warn(`getExtensions failed: ${(err as Error).message}`)
      return []
    }
  }

  async download(extension: IGalleryExtension): Promise<string> {
    await fs.mkdir(this._cacheDir, { recursive: true })
    const file = join(this._cacheDir, vsixFileName(extension))
    if (await pathExists(file)) {
      this._logger.info(`vsix cache hit for ${extension.identifier}@${extension.version}`)
      return file
    }

    const res = await fetch(extension.vsixUrl, { redirect: 'follow' })
    if (!res.ok) throw new Error(`download ${extension.identifier}: HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())

    // Write to a temp file then rename so a partial download never looks complete.
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, buffer)
      await fs.rename(tmp, file)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    this._logger.info(`downloaded ${extension.identifier}@${extension.version}`)
    return file
  }

  async getReadme(extension: IGalleryExtension): Promise<string> {
    if (!extension.readmeUrl) return ''
    const cached = this._readmeCache.get(extension.readmeUrl)
    if (cached !== undefined) return cached
    try {
      const res = await fetch(extension.readmeUrl, { redirect: 'follow' })
      if (!res.ok) return ''
      const text = await res.text()
      this._readmeCache.set(extension.readmeUrl, text)
      return text
    } catch (err) {
      this._logger.warn(`getReadme failed: ${(err as Error).message}`)
      return ''
    }
  }

  async getIcon(extension: IGalleryExtension): Promise<string> {
    if (!extension.iconUrl) return ''
    const cached = this._iconCache.get(extension.iconUrl)
    if (cached !== undefined) return cached
    try {
      const res = await fetch(extension.iconUrl, { redirect: 'follow' })
      if (!res.ok) return ''
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
      const base64 = Buffer.from(await res.arrayBuffer()).toString('base64')
      const dataUrl = `data:${mime};base64,${base64}`
      this._iconCache.set(extension.iconUrl, dataUrl)
      return dataUrl
    } catch (err) {
      this._logger.warn(`getIcon failed: ${(err as Error).message}`)
      return ''
    }
  }

  async getControlManifest(): Promise<IExtensionControlManifest> {
    const base = this._galleryUrl
    if (!base) return EMPTY_CONTROL

    if (this._controlCache && Date.now() - this._controlCache.fetchedAt < CONTROL_TTL_MS) {
      return this._controlCache.manifest
    }

    try {
      const res = await fetch(`${base}/control.json`, { redirect: 'follow' })
      if (!res.ok) return this._controlCache?.manifest ?? EMPTY_CONTROL
      const manifest = normalizeControl(await res.json())
      this._controlCache = { manifest, fetchedAt: Date.now() }
      return manifest
    } catch (err) {
      this._logger.warn(`control manifest fetch failed: ${(err as Error).message}`)
      return this._controlCache?.manifest ?? EMPTY_CONTROL
    }
  }

  private async _postQuery(base: string, body: unknown): Promise<IRawGalleryQueryResult> {
    const res = await fetch(`${base}/extensionquery`, {
      method: 'POST',
      headers: {
        Accept: QUERY_ACCEPT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as IRawGalleryQueryResult
  }
}

/** `<publisher>.<name>-<version>.vsix`, matching VSCode's cache naming. */
function vsixFileName(extension: IGalleryExtension): string {
  return `${extension.identifier}-${extension.version}.vsix`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Coerce an untrusted control.json body into the strict manifest shape. */
function normalizeControl(raw: unknown): IExtensionControlManifest {
  if (!raw || typeof raw !== 'object') return EMPTY_CONTROL
  const obj = raw as Record<string, unknown>
  const malicious = Array.isArray(obj.malicious)
    ? obj.malicious.filter((x): x is string => typeof x === 'string')
    : []
  const deprecated: Record<string, { reason?: string; migrateTo?: string }> = {}
  if (obj.deprecated && typeof obj.deprecated === 'object') {
    for (const [id, value] of Object.entries(obj.deprecated as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        deprecated[id] = {}
        continue
      }
      const v = value as Record<string, unknown>
      deprecated[id] = {
        ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
        ...(typeof v.migrateTo === 'string' ? { migrateTo: v.migrateTo } : {}),
      }
    }
  }
  return { malicious, deprecated }
}
