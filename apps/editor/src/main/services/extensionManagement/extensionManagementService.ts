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
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { version as HOST_API_VERSION } from '@universe-editor/extension-api'
import { readVsixManifest, extractVsix } from '@universe-editor/extension-packaging'
import { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
import {
  satisfies,
  compareVersions,
  type IExtensionManifest,
} from '@universe-editor/extensions-common'
import type { IGalleryExtension } from '@universe-editor/extension-gallery'
import type {
  ILocalExtension,
  IExtensionGalleryMetadata,
  IExtensionManagementService,
  IExtensionUpdate,
} from '../../../shared/ipc/extensionManagementService.js'
import { IExtensionGalleryService } from '../../../shared/ipc/extensionGalleryService.js'
import { resolveUserExtensionsDir } from '../extensionHost/userExtensionsDir.js'
import {
  readInstalledRecords,
  writeInstalledRecords,
  readEnablement,
  writeEnablement,
  readObsolete,
  writeObsolete,
  type IInstalledExtensionRecord,
} from './installedExtensionsManifest.js'

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

/** Folder name for an installed extension: `<id>-<version>`. */
function folderName(id: string, version: string): string {
  return `${id}-${version}`
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

  constructor(
    private readonly _resolveDir: UserExtensionsDirResolver = resolveUserExtensionsDir,
    private readonly _hostApiVersion: string = HOST_API_VERSION,
    @IExtensionGalleryService private readonly _gallery?: IManagementGallery,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'extensionManagement',
      name: 'Extension Management',
    })
    // Best-effort obsolete sweep on startup (files are unlocked now).
    void this._sweepObsolete()
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

  async getInstalled(): Promise<ILocalExtension[]> {
    const dir = this._resolveDir()
    const records = await readInstalledRecords(dir)
    const result: ILocalExtension[] = []
    for (const rec of records) {
      const location = path.join(dir, rec.location)
      try {
        const manifest = parseManifest(await readManifestJson(location))
        result.push(toLocalExtension(rec, location, manifest))
      } catch (err) {
        this._logger.warn(
          `installed extension ${rec.identifier} has an unreadable manifest: ${(err as Error).message}`,
        )
      }
    }
    return result
  }

  installVSIX(vsixPath: string): Promise<ILocalExtension> {
    return this._enqueue(() => this._installVSIX(vsixPath))
  }

  installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension> {
    return this._enqueue(() => this._installFromGallery(extension))
  }

  private async _installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension> {
    if (!this._gallery) throw new Error('marketplace is not available')

    await this._assertNotMalicious(extension.identifier)

    const vsixPath = await this._gallery.download(extension)
    const manifest = readVsixManifest(vsixPath)

    // Anti-poisoning: the downloaded package must be exactly what the gallery
    // advertised. A mismatch means the file was swapped in transit or the backend
    // is inconsistent — refuse it rather than install something unexpected.
    const downloadedId = extensionId(manifest)
    if (downloadedId !== extension.identifier || manifest.version !== extension.version) {
      throw new Error(
        `downloaded package (${downloadedId}@${manifest.version}) does not match the ` +
          `marketplace entry (${extension.identifier}@${extension.version})`,
      )
    }

    const galleryMetadata: IExtensionGalleryMetadata = {
      ...(extension.publisherDisplayName
        ? { publisherDisplayName: extension.publisherDisplayName }
        : {}),
      ...(extension.installCount !== undefined ? { installCount: extension.installCount } : {}),
      vsixUrl: extension.vsixUrl,
    }
    return this._install(vsixPath, manifest, 'gallery', galleryMetadata)
  }

  private async _installVSIX(vsixPath: string): Promise<ILocalExtension> {
    const manifest = readVsixManifest(vsixPath)
    await this._assertNotMalicious(extensionId(manifest))
    return this._install(vsixPath, manifest, 'vsix', undefined)
  }

  private async _install(
    vsixPath: string,
    manifest: IExtensionManifest,
    source: 'vsix' | 'gallery',
    galleryMetadata: IExtensionGalleryMetadata | undefined,
  ): Promise<ILocalExtension> {
    if (!satisfies(this._hostApiVersion, manifest.engines.universe)) {
      throw new Error(
        `extension requires universe ${manifest.engines.universe}, host API is ${this._hostApiVersion}`,
      )
    }

    const id = extensionId(manifest)
    const version = manifest.version
    const dir = this._resolveDir()
    const location = folderName(id, version)
    const targetDir = path.join(dir, location)

    await fs.mkdir(dir, { recursive: true })

    // Idempotent: same id+version already installed and on disk → return it.
    const records = await readInstalledRecords(dir)
    const existing = records.find((r) => r.identifier === id && r.version === version)
    if (existing && (await pathExists(targetDir))) {
      this._logger.info(`extension ${id}@${version} already installed`)
      return toLocalExtension(existing, targetDir, manifest)
    }

    // Clear any obsolete mark on the target folder before writing into it.
    await this._clearObsolete(dir, location)

    const tmpDir = path.join(dir, `.${randomUUID()}.tmp`)
    try {
      await fs.mkdir(tmpDir, { recursive: true })
      await extractVsix(vsixPath, tmpDir)
      // If a stale folder exists (same version reinstall after partial state), drop it.
      await fs.rm(targetDir, { recursive: true, force: true })
      await fs.rename(tmpDir, targetDir)
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }

    const record: IInstalledExtensionRecord = {
      identifier: id,
      version,
      location,
      source,
      installedAt: Date.now(),
      ...(galleryMetadata ? { galleryMetadata } : {}),
    }
    const next = [...records.filter((r) => r.identifier !== id || r.version !== version), record]
    await writeInstalledRecords(dir, next)

    this._logger.info(`installed extension ${id}@${version} from ${source}`)
    this._onDidChangeExtensions.fire()
    return toLocalExtension(record, targetDir, manifest)
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

  uninstall(identifier: string): Promise<void> {
    return this._enqueue(() => this._uninstall(identifier))
  }

  private async _uninstall(identifier: string): Promise<void> {
    const dir = this._resolveDir()
    const records = await readInstalledRecords(dir)
    const record = records.find((r) => r.identifier === identifier)
    if (!record) {
      this._logger.warn(`uninstall: ${identifier} is not installed`)
      return
    }

    const next = records.filter((r) => r.identifier !== identifier)
    await writeInstalledRecords(dir, next)

    const targetDir = path.join(dir, record.location)
    try {
      await fs.rm(targetDir, { recursive: true, force: true })
      this._logger.info(`uninstalled extension ${identifier}`)
    } catch (err) {
      // Windows may hold the files open (extension running); mark for later sweep.
      this._logger.warn(
        `uninstall ${identifier}: could not remove folder now, marking obsolete: ${(err as Error).message}`,
      )
      const marks = await readObsolete(dir)
      marks[record.location] = true
      await writeObsolete(dir, marks)
    }

    this._onDidChangeExtensions.fire()
  }

  async getDisabledIds(): Promise<string[]> {
    const enablement = await readEnablement(this._resolveDir())
    return Object.keys(enablement).filter((id) => enablement[id] === false)
  }

  setEnablement(identifier: string, enabled: boolean): Promise<void> {
    return this._enqueue(() => this._setEnablement(identifier, enabled))
  }

  private async _setEnablement(identifier: string, enabled: boolean): Promise<void> {
    const dir = this._resolveDir()
    const enablement = await readEnablement(dir)
    if (enabled) delete enablement[identifier]
    else enablement[identifier] = false
    await writeEnablement(dir, enablement)
    this._logger.info(`${enabled ? 'enabled' : 'disabled'} extension ${identifier}`)
    this._onDidChangeExtensions.fire()
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
        this._onDidChangeExtensions.fire()
      }
      return disabled
    })
  }

  async checkForUpdates(): Promise<IExtensionUpdate[]> {
    if (!this._gallery) return []
    const installed = await this.getInstalled()
    const galleryInstalled = installed.filter((e) => e.source === 'gallery')
    if (galleryInstalled.length === 0) return []

    let latest: IGalleryExtension[]
    try {
      latest = await this._gallery.getExtensions(galleryInstalled.map((e) => e.identifier))
    } catch (err) {
      this._logger.warn(`update check failed: ${(err as Error).message}`)
      return []
    }

    const updates: IExtensionUpdate[] = []
    for (const local of galleryInstalled) {
      const gallery = latest.find((g) => g.identifier === local.identifier)
      if (gallery && isNewerVersion(gallery.version, local.version)) {
        updates.push({
          identifier: local.identifier,
          fromVersion: local.version,
          toVersion: gallery.version,
          gallery,
        })
      }
    }
    return updates
  }

  async updateExtension(update: IExtensionUpdate): Promise<ILocalExtension> {
    return this.installFromGallery(update.gallery)
  }

  /** Remove a folder from the obsolete marks (called before reinstalling into it). */
  private async _clearObsolete(dir: string, location: string): Promise<void> {
    const marks = await readObsolete(dir)
    if (marks[location]) {
      delete marks[location]
      await writeObsolete(dir, marks)
    }
  }

  /** Delete every folder still marked obsolete; drop the ones we manage to remove. */
  private async _sweepObsolete(): Promise<void> {
    const dir = this._resolveDir()
    const marks = await readObsolete(dir)
    const remaining: typeof marks = {}
    let changed = false
    for (const location of Object.keys(marks)) {
      if (!marks[location]) continue
      try {
        await fs.rm(path.join(dir, location), { recursive: true, force: true })
        changed = true
      } catch {
        remaining[location] = true // still locked; keep for next start
      }
    }
    if (changed) await writeObsolete(dir, remaining)
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Read `package.json` text from an installed extension folder. */
async function readManifestJson(location: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'))
}
