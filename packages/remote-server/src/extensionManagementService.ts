/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Server-side extension-management channel. Manages the remote host's own
 *  user-extensions directory through the shared install engine (node-services),
 *  plus a chunked vsix upload buffer so the client can stream an already
 *  downloaded + signature-verified vsix up without the server needing any
 *  gallery/network stack. One service is built per connection (see server.ts);
 *  in-flight uploads stay connection-scoped, but the write queue is a process-level
 *  map keyed by the user-extensions dir so concurrent connections can't corrupt it.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import * as path from 'node:path'
import {
  Disposable,
  createNamedLogger,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { readVsixManifest } from '@universe-editor/extension-packaging'
import {
  findInstalledExtension,
  installVsix,
  listInstalledExtensions,
  readEnablement,
  readExtensionIconDataUrl,
  sweepObsolete,
  uninstallExtension,
  writeEnablement,
  type InstalledExtension,
  type IRemoteExtensionManagementService,
  type IRemoteInstallOptions,
  type IRemoteInstalledExtension,
} from '@universe-editor/node-services'
import { resolveUserExtensionsDir } from './serverPaths.js'

export interface RemoteExtensionManagementServiceOptions {
  readonly dataDir: string
  readonly loggerService: ILoggerService
}

/** Protocol contract is ≤ 1 MiB per chunk; reject anything over 4× that as a guard. */
const MAX_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024

/** `locale` is joined into a filesystem path, so constrain it to safe characters. */
const LOCALE_RE = /^[A-Za-z0-9._-]{1,32}$/

/**
 * Serializes install/uninstall/setEnablement per user-extensions directory, so
 * concurrent read-modify-write on `extensions.json` from multiple management
 * connections in the same daemon can't silently drop records. Keyed by the
 * resolved directory because one connection is built per client (see server.ts)
 * while every connection writes the same `<dataDir>/user-extensions` file.
 */
const writeQueues = new Map<string, Promise<unknown>>()

/** `<publisher>.<name>` when a publisher is present, else `<name>`. */
function extensionId(manifest: { publisher?: string; name: string }): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name
}

/** Map an engine result (which carries the on-disk location) to the path-free DTO. */
function toInstalledDto(e: InstalledExtension): IRemoteInstalledExtension {
  return {
    identifier: e.record.identifier,
    version: e.record.version,
    manifest: e.manifest,
    source: e.record.source,
    installedAt: e.record.installedAt,
    ...(e.record.galleryMetadata ? { galleryMetadata: e.record.galleryMetadata } : {}),
  }
}

export class RemoteExtensionManagementService
  extends Disposable
  implements IRemoteExtensionManagementService
{
  private readonly _userExtensionsDir: string
  private readonly _uploadDir: string
  private readonly _log: ILogger

  /** uploadId → temp vsix path (the chunk buffer, removed on install/abort/dispose). */
  private readonly _uploads = new Map<string, string>()

  /** Resolves when the constructor's best-effort startup sweep finishes (tests await this). */
  readonly whenStartupSweepSettled: Promise<void>

  constructor(options: RemoteExtensionManagementServiceOptions) {
    super()
    this._userExtensionsDir = resolveUserExtensionsDir(options.dataDir)
    this._uploadDir = path.join(options.dataDir, 'tmp')
    this._log = createNamedLogger(options.loggerService, {
      id: 'extensionManagement',
      name: 'Extension Management',
    })
    // Best-effort startup cleanup (idempotent + cheap, so per-connection runs are fine).
    this.whenStartupSweepSettled = this._sweepOnStartup()
  }

  async listInstalled(locale?: string | null): Promise<IRemoteInstalledExtension[]> {
    const installed = await listInstalledExtensions(
      this._userExtensionsDir,
      locale ?? undefined,
      (message) => this._log.warn(message),
    )
    return installed.map(toInstalledDto)
  }

  async uploadBegin(): Promise<string> {
    await fs.mkdir(this._uploadDir, { recursive: true })
    const uploadId = randomUUID()
    this._uploads.set(uploadId, path.join(this._uploadDir, `${uploadId}.vsix`))
    return uploadId
  }

  async uploadChunk(uploadId: string, chunk: Uint8Array): Promise<void> {
    const tmpPath = this._uploads.get(uploadId)
    if (!tmpPath) throw new Error(`unknown upload id: ${uploadId}`)
    if (chunk.byteLength > MAX_UPLOAD_CHUNK_SIZE) {
      throw new Error(
        `upload chunk too large: ${chunk.byteLength} bytes (max ${MAX_UPLOAD_CHUNK_SIZE})`,
      )
    }
    await fs.appendFile(tmpPath, chunk)
  }

  async uploadAbort(uploadId: string): Promise<void> {
    const tmpPath = this._uploads.get(uploadId)
    if (!tmpPath) return
    this._uploads.delete(uploadId)
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
  }

  installUploaded(
    uploadId: string,
    expected: { readonly identifier: string; readonly version: string },
    options: IRemoteInstallOptions,
  ): Promise<IRemoteInstalledExtension> {
    return this._enqueue(() => this._installUploaded(uploadId, expected, options))
  }

  private async _installUploaded(
    uploadId: string,
    expected: { readonly identifier: string; readonly version: string },
    options: IRemoteInstallOptions,
  ): Promise<IRemoteInstalledExtension> {
    const tmpVsix = this._takeUpload(uploadId)
    try {
      if (options.source !== 'vsix' && options.source !== 'gallery') {
        throw new Error(`invalid install source: ${String(options.source)}`)
      }
      if (options.locale !== undefined && !LOCALE_RE.test(options.locale)) {
        throw new Error(`invalid locale: ${options.locale}`)
      }
      const manifest = readVsixManifest(tmpVsix)
      const id = extensionId(manifest)
      if (id !== expected.identifier || manifest.version !== expected.version) {
        throw new Error(
          `uploaded package (${id}@${manifest.version}) does not match expected (${expected.identifier}@${expected.version})`,
        )
      }
      // No hostApiVersion here by design: engines compatibility is validated on
      // the client before upload (see extensionManagementProtocol.ts).
      const installed = await installVsix(this._userExtensionsDir, tmpVsix, {
        source: options.source,
        ...(options.galleryMetadata ? { galleryMetadata: options.galleryMetadata } : {}),
        ...(options.locale ? { locale: options.locale } : {}),
        logger: this._log,
      })
      return toInstalledDto(installed)
    } finally {
      await fs.rm(tmpVsix, { force: true }).catch(() => undefined)
    }
  }

  uninstall(identifier: string): Promise<boolean> {
    return this._enqueue(() => uninstallExtension(this._userExtensionsDir, identifier, this._log))
  }

  async getDisabledIds(): Promise<string[]> {
    const enablement = await readEnablement(this._userExtensionsDir)
    return Object.keys(enablement).filter((id) => enablement[id] === false)
  }

  setEnablement(identifier: string, enabled: boolean): Promise<void> {
    return this._enqueue(() => this._setEnablement(identifier, enabled))
  }

  private async _setEnablement(identifier: string, enabled: boolean): Promise<void> {
    const enablement = await readEnablement(this._userExtensionsDir)
    if (enabled) delete enablement[identifier]
    else enablement[identifier] = false
    await writeEnablement(this._userExtensionsDir, enablement)
    this._log.info(`${enabled ? 'enabled' : 'disabled'} extension ${identifier}`)
  }

  async getIcon(identifier: string): Promise<string> {
    const ext = await findInstalledExtension(this._userExtensionsDir, identifier)
    const iconPath = ext?.manifest.icon
    if (!ext || !iconPath) return ''
    return readExtensionIconDataUrl(ext.location, iconPath)
  }

  /** Run `fn` after any in-flight management op on this dir; errors don't break the chain. */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(this._userExtensionsDir)
    const tail = writeQueues.get(key) ?? Promise.resolve()
    const run = tail.then(fn, fn)
    writeQueues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /** Best-effort startup cleanup: obsolete marks + stale temp-vsix orphans. */
  private async _sweepOnStartup(): Promise<void> {
    try {
      await sweepObsolete(this._userExtensionsDir)
    } catch (err) {
      this._log.warn(`startup obsolete sweep failed: ${(err as Error).message}`)
    }
    await this._sweepStaleUploads()
  }

  /** Delete `<dataDir>/tmp/*.vsix` files older than 24h (orphans from dead uploads). */
  private async _sweepStaleUploads(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this._uploadDir)
    } catch {
      return // no tmp dir yet
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of entries) {
      if (!name.endsWith('.vsix')) continue
      const full = path.join(this._uploadDir, name)
      try {
        const st = await fs.stat(full)
        if (st.mtimeMs < cutoff) await fs.rm(full, { force: true })
      } catch {
        // Silent: a fresh/in-flight file must never be removed on a stat error.
      }
    }
  }

  /** Remove an upload from the in-flight map; throws for an unknown id. */
  private _takeUpload(uploadId: string): string {
    const tmpPath = this._uploads.get(uploadId)
    if (!tmpPath) throw new Error(`unknown upload id: ${uploadId}`)
    this._uploads.delete(uploadId)
    return tmpPath
  }

  override dispose(): void {
    for (const tmpPath of this._uploads.values()) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // best-effort cleanup
      }
    }
    this._uploads.clear()
    super.dispose()
  }
}
