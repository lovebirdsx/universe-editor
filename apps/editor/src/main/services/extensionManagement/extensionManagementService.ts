/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process extension management: turns a `.vsix` (local or downloaded from the
 *  marketplace) into an installed extension the restricted host will scan, and
 *  manages its lifecycle. Mirrors VSCode's `IExtensionManagementService`.
 *
 *  Install is atomic (extract to a temp dir, then rename into place) so the
 *  scanner never sees a half-written extension. Uninstall removes the folder, or
 *  marks it `.obsolete` when Windows holds the files open (a running extension) so
 *  it's swept on next start. State of record is `extensions.json`. Before any
 *  install the control manifest is consulted — a malicious id is refused.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  RemoteChannels,
  type Event,
  type ILogger,
  localize,
} from '@universe-editor/platform'
import { readVsixManifest, verifyVsixSignature } from '@universe-editor/extension-packaging'
import { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
import {
  compareVersions,
  satisfies,
  type IExtensionManifest,
  type IInstalledExtensionRecord,
} from '@universe-editor/extensions-common'
import { pickCompatibleVersion, type IGalleryExtension } from '@universe-editor/extension-gallery'
import {
  installVsix,
  listInstalledExtensions,
  readEnablement,
  readExtensionIconDataUrl,
  readInstalledRecords,
  readManifestJson,
  sweepObsolete,
  uninstallExtension,
  writeEnablement,
  type IRemoteExtensionManagementService,
  type IRemoteInstalledExtension,
  type IRemoteInstallOptions,
} from '@universe-editor/node-services'
import type {
  ILocalExtension,
  IExtensionGalleryMetadata,
  IExtensionManagementService,
  IExtensionUpdate,
} from '../../../shared/ipc/extensionManagementService.js'
import { IExtensionGalleryService } from '../../../shared/ipc/extensionGalleryService.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'
import { resolveUserExtensionsDir } from '../extensionHost/userExtensionsDir.js'
import { resolveBuiltinExtensionsDir } from '../extensionHost/builtinExtensionsDir.js'
import { BUILTIN_MARKETPLACE_SIGNING_KEYS } from './marketplaceSigningKeys.js'

/** Chunk size for streaming a VSIX to the remote host (≤ 1 MiB tunnel attachment). */
const REMOTE_UPLOAD_CHUNK_SIZE = 1024 * 1024

/** Resolves the user extensions directory. Injectable for tests. */
export type UserExtensionsDirResolver = () => string

/** Minimal view of the gallery service needed to install + guard. Injectable for tests. */
export interface IManagementGallery {
  download(extension: IGalleryExtension): Promise<string>
  getControlManifest(): Promise<{ malicious: readonly string[] }>
  getExtensions(ids: readonly string[]): Promise<IGalleryExtension[]>
}

/** `<publisher>.<name>` when a publisher is present, else `<name>`. */
function extensionId(manifest: IExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name
}

/** Thrown when an install is refused because the control manifest marks it malicious. */
export class MaliciousExtensionError extends Error {
  constructor(readonly identifier: string) {
    super(`extension ${identifier} is marked malicious and cannot be installed`)
    this.name = 'MaliciousExtensionError'
  }
}

/** True when `candidate` is a strictly higher semver than `current`. */
function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export class ExtensionManagementMainService
  extends Disposable
  implements IExtensionManagementService
{
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeExtensions = this._register(new Emitter<void>())
  readonly onDidChangeExtensions: Event<void> = this._onDidChangeExtensions.event

  private readonly _logger: ILogger

  /** Serializes install/uninstall so concurrent writes can't corrupt extensions.json. */
  private _queue: Promise<unknown> = Promise.resolve()

  /** identifier → local icon data URL ('' when none); invalidated on install/uninstall. */
  private readonly _localIconCache = new Map<string, string>()

  /** Resolves when the constructor's best-effort startup sweep finishes (tests await this). */
  readonly whenStartupSweepSettled: Promise<void>

  constructor(
    private readonly _resolveDir: UserExtensionsDirResolver = resolveUserExtensionsDir,
    /** Editor app version `engines.universe` is checked against (DI passes getAppVersion()). */
    private readonly _hostApiVersion: string,
    @IExtensionGalleryService private readonly _gallery?: IManagementGallery,
    @ILoggerService loggerService?: ILoggerService,
    private readonly _resolveBuiltinDir: UserExtensionsDirResolver = resolveBuiltinExtensionsDir,
    private readonly _resolveDevExtensionPaths: () => readonly string[] = () => [],
    private readonly _signingKeys: Readonly<
      Record<string, string>
    > = BUILTIN_MARKETPLACE_SIGNING_KEYS,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'extensionManagement',
      name: 'Extension Management',
    })
    // Best-effort obsolete sweep on startup (files are unlocked now).
    this.whenStartupSweepSettled = this._sweepObsolete()
  }

  /** Run `fn` after any in-flight management op; errors don't break the chain. */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Icon cache is keyed by identifier but folders change on install; drop it + notify. */
  private _notifyChanged(): void {
    this._localIconCache.clear()
    this._onDidChangeExtensions.fire()
  }

  /** Resolve the stable per-(authority, channel) proxy; never cached across calls. */
  private _remoteProxy(authority: string): IRemoteExtensionManagementService {
    if (!this._connections) {
      throw new Error(
        localize(
          'extManagement.error.remoteUnavailable',
          'Remote extension management is unavailable for {authority}.',
          { authority },
        ),
      )
    }
    return this._connections.getServiceProxy<IRemoteExtensionManagementService>(
      authority,
      RemoteChannels.ExtensionManagement,
    )
  }

  /** Run a remote read, annotating failures with the authority for user visibility. */
  private async _callRemote<T>(
    authority: string,
    fn: (service: IRemoteExtensionManagementService) => Promise<T>,
  ): Promise<T> {
    const service = this._remoteProxy(authority)
    try {
      return await fn(service)
    } catch (err) {
      throw this._wrapRemoteError(authority, err)
    }
  }

  private _wrapRemoteError(authority: string, err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err)
    return new Error(
      localize(
        'extManagement.error.remoteOperation',
        'Extension operation on {authority} failed: {message}',
        { authority, message },
      ),
    )
  }

  /** Client-side engine gate for remote installs (the server re-checks only id/version). */
  private _assertCompatibleHost(manifest: IExtensionManifest): void {
    if (!satisfies(this._hostApiVersion, manifest.engines.universe)) {
      throw new Error(
        localize(
          'extManagement.error.engineMismatch',
          'The extension requires universe {required}, host API is {actual}.',
          { required: manifest.engines.universe, actual: this._hostApiVersion },
        ),
      )
    }
  }

  /**
   * Stream a locally-verified VSIX to the remote host in ≤ 1 MiB chunks and
   * install it from the server-side temp file. Aborts the upload on any failure.
   */
  private async _uploadAndInstall(
    vsixPath: string,
    authority: string,
    manifest: IExtensionManifest,
    options: IRemoteInstallOptions,
  ): Promise<ILocalExtension> {
    this._assertCompatibleHost(manifest)
    const expected = { identifier: extensionId(manifest), version: manifest.version }
    const service = this._remoteProxy(authority)
    const handle = await fs.open(vsixPath, 'r')
    let uploadId: string | undefined
    try {
      uploadId = await service.uploadBegin()
      let offset = 0
      for (;;) {
        // A fresh buffer each round: the tunnel may serialize the previous chunk
        // after this iteration returns, so it must not be overwritten in place.
        const buffer = Buffer.alloc(REMOTE_UPLOAD_CHUNK_SIZE)
        const { bytesRead } = await handle.read(buffer, 0, REMOTE_UPLOAD_CHUNK_SIZE, offset)
        if (bytesRead === 0) break
        await service.uploadChunk(uploadId, buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      const installed = await service.installUploaded(uploadId, expected, options)
      this._notifyChanged()
      return toRemoteLocalExtension(installed)
    } catch (err) {
      if (uploadId !== undefined) {
        await service.uploadAbort(uploadId).catch(() => undefined)
      }
      throw this._wrapRemoteError(authority, err)
    } finally {
      await handle.close()
    }
  }

  async getInstalled(authority?: string): Promise<ILocalExtension[]> {
    if (authority !== undefined) {
      const installed = await this._callRemote(authority, (s) =>
        s.listInstalled(getCurrentLocale()),
      )
      return installed.map(toRemoteLocalExtension)
    }
    const installed = await listInstalledExtensions(
      this._resolveDir(),
      getCurrentLocale(),
      (message) => this._logger.warn(message),
    )
    return installed.map((e) => ({
      ...toLocalExtension(e.record, e.location, e.manifest),
      ...engineCompat(this._hostApiVersion, e.manifest),
    }))
  }

  async listBuiltinExtensions(): Promise<ILocalExtension[]> {
    const dir = this._resolveBuiltinDir()
    let names: string[]
    try {
      names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return [] // no built-in dir (unexpected, but degrade to empty)
    }
    const result: ILocalExtension[] = []
    for (const name of names) {
      const location = path.join(dir, name)
      try {
        const manifest = parseManifest(await readManifestJson(location, getCurrentLocale()))
        result.push({
          identifier: extensionId(manifest),
          manifest,
          version: manifest.version,
          location,
          source: 'builtin',
          installedAt: 0,
          ...engineCompat(this._hostApiVersion, manifest),
        })
      } catch (err) {
        this._logger.warn(
          `built-in extension ${name} has an unreadable manifest: ${(err as Error).message}`,
        )
      }
    }
    return result
  }

  async listDevExtensions(): Promise<ILocalExtension[]> {
    const result: ILocalExtension[] = []
    for (const devPath of this._resolveDevExtensionPaths()) {
      try {
        const manifest = parseManifest(await readManifestJson(devPath, getCurrentLocale()))
        result.push({
          identifier: extensionId(manifest),
          manifest,
          version: manifest.version,
          location: devPath,
          source: 'development',
          installedAt: 0,
          ...engineCompat(this._hostApiVersion, manifest),
        })
      } catch (err) {
        this._logger.warn(
          `dev extension at ${devPath} has an unreadable manifest: ${(err as Error).message}`,
        )
      }
    }
    return result
  }

  installVSIX(vsixPath: string, authority?: string): Promise<ILocalExtension> {
    return this._enqueue(() =>
      authority !== undefined
        ? this._installVSIXRemote(vsixPath, authority)
        : this._installVSIX(vsixPath),
    )
  }

  installFromGallery(extension: IGalleryExtension, authority?: string): Promise<ILocalExtension> {
    return this._enqueue(() =>
      authority !== undefined
        ? this._installFromGalleryRemote(extension, authority)
        : this._installFromGallery(extension),
    )
  }

  private async _installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension> {
    const { vsixPath, galleryMetadata } = await this._downloadAndVerifyGallery(extension)
    return this._install(vsixPath, 'gallery', galleryMetadata)
  }

  /** Shared with the local path so the poison/signature gates stay in one place. */
  private async _installFromGalleryRemote(
    extension: IGalleryExtension,
    authority: string,
  ): Promise<ILocalExtension> {
    const { vsixPath, manifest, galleryMetadata } = await this._downloadAndVerifyGallery(extension)
    return this._uploadAndInstall(vsixPath, authority, manifest, {
      source: 'gallery',
      galleryMetadata,
      locale: getCurrentLocale(),
    })
  }

  /**
   * Download the marketplace VSIX and run every local gate on it (malicious,
   * id/version anti-poisoning, fail-closed signature), returning the verified
   * bytes' path + manifest + gallery metadata for the caller to install.
   */
  private async _downloadAndVerifyGallery(extension: IGalleryExtension): Promise<{
    vsixPath: string
    manifest: IExtensionManifest
    galleryMetadata: IExtensionGalleryMetadata
  }> {
    if (!this._gallery) {
      throw new Error(
        localize('extManagement.error.noMarketplace', 'The marketplace is not available.'),
      )
    }

    // Version selection: pick the newest version compatible with the host API
    // version instead of blindly installing the latest (which may require a newer
    // editor). The manifest `engines.universe` check in `_install` stays as a
    // second gate.
    const selected = pickCompatibleVersion(extension, this._hostApiVersion)
    if (!selected) {
      throw new Error(
        `No compatible version of ${extension.identifier} for Universe ${this._hostApiVersion}`,
      )
    }

    // Narrow the gallery entry to the selected version so download, the
    // anti-poisoning check, and signature verification all operate on exactly
    // the version we chose.
    const target: IGalleryExtension = {
      ...extension,
      version: selected.version,
      vsixUrl: selected.vsixUrl,
      ...(selected.vsixHash !== undefined ? { vsixHash: selected.vsixHash } : {}),
      ...(selected.vsixSignature !== undefined ? { vsixSignature: selected.vsixSignature } : {}),
    }

    await this._assertNotMalicious(target.identifier)

    const vsixPath = await this._gallery.download(target)
    const manifest = readVsixManifest(vsixPath)

    // Anti-poisoning: the downloaded package must be exactly what the gallery
    // advertised. A mismatch means the file was swapped in transit or the backend
    // is inconsistent — refuse it rather than install something unexpected.
    const downloadedId = extensionId(manifest)
    if (downloadedId !== target.identifier || manifest.version !== target.version) {
      throw new Error(
        localize(
          'extManagement.error.packageMismatch',
          'The downloaded package ({downloadedId}@{downloadedVersion}) does not match the marketplace entry ({expectedId}@{expectedVersion}).',
          {
            downloadedId,
            downloadedVersion: manifest.version,
            expectedId: target.identifier,
            expectedVersion: target.version,
          },
        ),
      )
    }

    // Marketplace signature gate (fail-closed): the VSIX bytes must verify
    // against the marketplace signing key built into the client. An unsigned
    // entry or any mismatch means the package (or registry) was tampered with.
    if (!target.vsixHash || !target.vsixSignature) {
      throw new Error(
        localize(
          'extManagement.error.unsigned',
          'Marketplace entry {id}@{version} is unsigned — refusing to install.',
          { id: target.identifier, version: target.version },
        ),
      )
    }
    await verifyVsixSignature(
      vsixPath,
      { hash: target.vsixHash, signature: target.vsixSignature },
      this._signingKeys,
    )
    this._logger.info(
      `verified marketplace signature for ${target.identifier}@${target.version} (keyId ${target.vsixSignature.keyId})`,
    )

    const galleryMetadata: IExtensionGalleryMetadata = {
      ...(extension.publisherDisplayName
        ? { publisherDisplayName: extension.publisherDisplayName }
        : {}),
      ...(extension.installCount !== undefined ? { installCount: extension.installCount } : {}),
      vsixUrl: target.vsixUrl,
      vsixHash: target.vsixHash,
    }
    return { vsixPath, manifest, galleryMetadata }
  }

  private async _installVSIX(vsixPath: string): Promise<ILocalExtension> {
    const manifest = readVsixManifest(vsixPath)
    await this._assertNotMalicious(extensionId(manifest))
    // No signature verification here by design: a local file was explicitly
    // chosen by the user (explicit trust), and there is no marketplace
    // signature to check it against.
    return this._install(vsixPath, 'vsix', undefined)
  }

  private async _installVSIXRemote(vsixPath: string, authority: string): Promise<ILocalExtension> {
    const manifest = readVsixManifest(vsixPath)
    await this._assertNotMalicious(extensionId(manifest))
    return this._uploadAndInstall(vsixPath, authority, manifest, {
      source: 'vsix',
      locale: getCurrentLocale(),
    })
  }

  private async _install(
    vsixPath: string,
    source: 'vsix' | 'gallery',
    galleryMetadata: IExtensionGalleryMetadata | undefined,
  ): Promise<ILocalExtension> {
    const result = await installVsix(this._resolveDir(), vsixPath, {
      source,
      ...(galleryMetadata ? { galleryMetadata } : {}),
      hostApiVersion: this._hostApiVersion,
      locale: getCurrentLocale(),
      logger: this._logger,
    })
    this._notifyChanged()
    return toLocalExtension(result.record, result.location, result.manifest)
  }

  /** Refuse an install of an id the control manifest marks malicious. */
  private async _assertNotMalicious(id: string): Promise<void> {
    if (!this._gallery) return
    try {
      const control = await this._gallery.getControlManifest()
      if (control.malicious.includes(id)) {
        throw new MaliciousExtensionError(id)
      }
    } catch (err) {
      if (err instanceof MaliciousExtensionError) throw err
      // A failed control fetch must not block installs — fail open on the guard,
      // fail closed only on a positive malicious hit.
      this._logger.warn(`control manifest check skipped for ${id}: ${(err as Error).message}`)
    }
  }

  uninstall(identifier: string, authority?: string): Promise<void> {
    return this._enqueue(() =>
      authority !== undefined
        ? this._uninstallRemote(identifier, authority)
        : this._uninstall(identifier),
    )
  }

  private async _uninstall(identifier: string): Promise<void> {
    const removed = await uninstallExtension(this._resolveDir(), identifier, this._logger)
    if (removed) this._notifyChanged()
  }

  private async _uninstallRemote(identifier: string, authority: string): Promise<void> {
    const service = this._remoteProxy(authority)
    let removed: boolean
    try {
      removed = await service.uninstall(identifier)
    } catch (err) {
      throw this._wrapRemoteError(authority, err)
    }
    if (removed) this._notifyChanged()
    else this._logger.warn(`uninstall: ${identifier} is not installed on ${authority}`)
  }

  async getDisabledIds(authority?: string): Promise<string[]> {
    if (authority !== undefined) {
      return this._callRemote(authority, (s) => s.getDisabledIds())
    }
    const enablement = await readEnablement(this._resolveDir())
    return Object.keys(enablement).filter((id) => enablement[id] === false)
  }

  /**
   * Read a locally-installed extension's own icon (the manifest `icon` path,
   * relative to its folder) as a `data:` URL — the renderer CSP blocks `file://`,
   * same as gallery icons. Returns '' when the extension declares no icon, isn't
   * found, or the file can't be read. Mirrors VSCode resolving `manifest.icon`
   * against the extension location.
   */
  async getLocalIcon(identifier: string, authority?: string): Promise<string> {
    if (authority !== undefined) {
      return this._callRemote(authority, (s) => s.getIcon(identifier))
    }
    const cached = this._localIconCache.get(identifier)
    if (cached !== undefined) return cached
    const dataUrl = await this._readLocalIcon(identifier)
    this._localIconCache.set(identifier, dataUrl)
    return dataUrl
  }

  private async _readLocalIcon(identifier: string): Promise<string> {
    const all = [
      ...(await this.getInstalled()),
      ...(await this.listBuiltinExtensions()),
      ...(await this.listDevExtensions()),
    ]
    const local = all.find((e) => e.identifier === identifier)
    const iconPath = local?.manifest.icon
    if (!local || !iconPath) return ''
    return readExtensionIconDataUrl(local.location, iconPath)
  }

  setEnablement(identifier: string, enabled: boolean, authority?: string): Promise<void> {
    return this._enqueue(() =>
      authority !== undefined
        ? this._setEnablementRemote(identifier, enabled, authority)
        : this._setEnablement(identifier, enabled),
    )
  }

  private async _setEnablementRemote(
    identifier: string,
    enabled: boolean,
    authority: string,
  ): Promise<void> {
    const service = this._remoteProxy(authority)
    try {
      await service.setEnablement(identifier, enabled)
    } catch (err) {
      throw this._wrapRemoteError(authority, err)
    }
    // No onDidChangeExtensions here, matching the local path: the renderer's
    // ExtensionEnablementService orchestrates the host restart.
  }

  private async _setEnablement(identifier: string, enabled: boolean): Promise<void> {
    const dir = this._resolveDir()
    const enablement = await readEnablement(dir)
    if (enabled) delete enablement[identifier]
    else enablement[identifier] = false
    await writeEnablement(dir, enablement)
    this._logger.info(`${enabled ? 'enabled' : 'disabled'} extension ${identifier}`)
    // No onDidChangeExtensions here: global enablement is orchestrated by the
    // renderer's ExtensionEnablementService, which fires its own change event
    // (firing here too would double-restart the extension hosts). quarantine
    // below is the exception — it runs stand-alone at startup and must signal.
  }

  async quarantineMalicious(): Promise<string[]> {
    if (!this._gallery) return []
    let malicious: readonly string[]
    try {
      malicious = (await this._gallery.getControlManifest()).malicious
    } catch (err) {
      this._logger.warn(`quarantine skipped: ${(err as Error).message}`)
      return []
    }
    if (malicious.length === 0) return []

    return this._enqueue(async () => {
      const dir = this._resolveDir()
      const installed = await readInstalledRecords(dir)
      const enablement = await readEnablement(dir)
      const disabled: string[] = []
      for (const rec of installed) {
        if (malicious.includes(rec.identifier) && enablement[rec.identifier] !== false) {
          enablement[rec.identifier] = false
          disabled.push(rec.identifier)
        }
      }
      if (disabled.length > 0) {
        await writeEnablement(dir, enablement)
        this._logger.warn(`quarantined malicious extensions: ${disabled.join(', ')}`)
        this._notifyChanged()
      }
      return disabled
    })
  }

  async checkForUpdates(authority?: string): Promise<IExtensionUpdate[]> {
    if (!this._gallery) return []
    const installed = await this.getInstalled(authority)
    return this._computeUpdates(this._gallery, installed)
  }

  /** Compare installed gallery extensions against the marketplace; shared local/remote. */
  private async _computeUpdates(
    gallery: IManagementGallery,
    installed: readonly ILocalExtension[],
  ): Promise<IExtensionUpdate[]> {
    const galleryInstalled = installed.filter((e) => e.source === 'gallery')
    if (galleryInstalled.length === 0) return []

    let latest: IGalleryExtension[]
    try {
      latest = await gallery.getExtensions(galleryInstalled.map((e) => e.identifier))
    } catch (err) {
      this._logger.warn(`update check failed: ${(err as Error).message}`)
      return []
    }

    const updates: IExtensionUpdate[] = []
    for (const local of galleryInstalled) {
      const galleryExt = latest.find((g) => g.identifier === local.identifier)
      if (!galleryExt) continue
      const compatible = pickCompatibleVersion(galleryExt, this._hostApiVersion)
      // No compatible version → never offer the (incompatible) latest as an update.
      if (!compatible) continue
      if (isNewerVersion(compatible.version, local.version)) {
        updates.push({
          identifier: local.identifier,
          fromVersion: local.version,
          toVersion: compatible.version,
          gallery: galleryExt,
        })
      }
    }
    return updates
  }

  async updateExtension(update: IExtensionUpdate, authority?: string): Promise<ILocalExtension> {
    return this.installFromGallery(update.gallery, authority)
  }

  /** Delete every folder still marked obsolete; drop the ones we manage to remove. */
  private async _sweepObsolete(): Promise<void> {
    await sweepObsolete(this._resolveDir())
  }
}

/**
 * `engines.universe` compatibility fields for a UI listing. Duplicates the host's
 * activation-time check (pure + cheap) so the Extensions UI can mark an
 * incompatible extension without a host round-trip.
 */
function engineCompat(
  hostApiVersion: string,
  manifest: IExtensionManifest,
): { readonly isVersionCompatible: boolean; readonly validationMessage?: string } {
  if (satisfies(hostApiVersion, manifest.engines.universe)) {
    return { isVersionCompatible: true }
  }
  return {
    isVersionCompatible: false,
    validationMessage: `requires universe ${manifest.engines.universe}, host is ${hostApiVersion}`,
  }
}

function toLocalExtension(
  record: IInstalledExtensionRecord,
  location: string,
  manifest: IExtensionManifest,
): ILocalExtension {
  return {
    identifier: record.identifier,
    manifest,
    version: record.version,
    location,
    source: record.source,
    installedAt: record.installedAt,
    ...(record.galleryMetadata ? { galleryMetadata: record.galleryMetadata } : {}),
  }
}

/** Map a remote DTO (server-private paths) to the wire shape; `location` stays ''. */
function toRemoteLocalExtension(e: IRemoteInstalledExtension): ILocalExtension {
  return {
    identifier: e.identifier,
    manifest: e.manifest,
    version: e.version,
    location: '',
    source: e.source,
    installedAt: e.installedAt,
    ...(e.galleryMetadata ? { galleryMetadata: e.galleryMetadata } : {}),
  }
}
