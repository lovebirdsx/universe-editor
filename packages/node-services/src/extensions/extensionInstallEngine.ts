/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-free install engine for user extensions. Extracts a `.vsix` (local or
 *  already downloaded from the marketplace) into `<dir>/<id>-<version>`, keeps
 *  `extensions.json` in sync, and handles uninstall + obsolete sweeping. Shared
 *  verbatim by the local main process and (later) the remote server so both manage
 *  their own host's extensions directory.
 *
 *  Gallery download / signature verification / anti-poisoning / malicious
 *  quarantine are deliberately NOT here — they are marketplace concerns the caller
 *  owns and performs before invoking `installVsix`.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { localize, type ILogger } from '@universe-editor/platform'
import { satisfies, type IExtensionManifest } from '@universe-editor/extensions-common'
import { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
import { readVsixManifest, extractVsix } from '@universe-editor/extension-packaging'
import type {
  IExtensionGalleryMetadata,
  IInstalledExtensionRecord,
} from '@universe-editor/extensions-common'
import { readManifestJson } from './nls.js'
import {
  deleteExtensionFolder,
  readInstalledRecords,
  readObsolete,
  sweepDeletedFolders,
  writeInstalledRecords,
  writeObsolete,
  type ObsoleteMarks,
} from './installedExtensionsManifest.js'

/** Minimal logger surface the engine writes through (info + warn only). */
export type ExtensionEngineLogger = Pick<ILogger, 'info' | 'warn'>

/** A user-installed extension with its on-disk manifest localized + parsed. */
export interface InstalledExtension {
  readonly record: IInstalledExtensionRecord
  /** Absolute path to the extension's installed folder. */
  readonly location: string
  readonly manifest: IExtensionManifest
}

export interface InstallVsixOptions {
  readonly source: 'vsix' | 'gallery'
  readonly galleryMetadata?: IExtensionGalleryMetadata
  /** When set, validate `engines.universe`; undefined skips (validated client-side). */
  readonly hostApiVersion?: string
  readonly locale?: string
  readonly logger?: ExtensionEngineLogger
}

/** `<publisher>.<name>` when a publisher is present, else `<name>`. */
function extensionId(manifest: IExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name
}

/** Folder name for an installed extension: `<id>-<version>`. */
function folderName(id: string, version: string): string {
  return `${id}-${version}`
}

/** `<id>-<version>` becomes a directory name: refuse separators and `..` escapes. */
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertSafeFolderSegment(kind: string, value: string): void {
  if (!FOLDER_NAME_RE.test(value) || value.includes('..')) {
    throw new Error(`extension ${kind} "${value}" is not a valid folder name`)
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

/** Remove a folder from the obsolete marks (called before reinstalling into it). */
async function clearObsolete(dir: string, location: string): Promise<void> {
  const marks = await readObsolete(dir)
  if (marks[location]) {
    delete marks[location]
    await writeObsolete(dir, marks)
  }
}

/** Parse one record's on-disk manifest (localized); throws when it can't be read. */
async function readInstalledExtension(
  dir: string,
  rec: IInstalledExtensionRecord,
  locale?: string,
): Promise<InstalledExtension> {
  const location = path.join(dir, rec.location)
  const manifest = parseManifest(await readManifestJson(location, locale))
  return { record: rec, location, manifest }
}

/**
 * List every extension in `extensions.json` whose on-disk manifest still reads.
 * A record whose manifest can't be read is skipped (with an optional warn) so one
 * corrupt install never hides the rest.
 */
export async function listInstalledExtensions(
  dir: string,
  locale?: string,
  onWarn?: (message: string) => void,
): Promise<InstalledExtension[]> {
  const records = await readInstalledRecords(dir)
  const result: InstalledExtension[] = []
  for (const rec of records) {
    try {
      result.push(await readInstalledExtension(dir, rec, locale))
    } catch (err) {
      onWarn?.(
        `installed extension ${rec.identifier} has an unreadable manifest: ${(err as Error).message}`,
      )
    }
  }
  return result
}

/**
 * Look up a single installed extension by identifier, parsing only that one's
 * manifest. Returns undefined when it isn't installed or its manifest can't be read.
 */
export async function findInstalledExtension(
  dir: string,
  identifier: string,
  locale?: string,
): Promise<InstalledExtension | undefined> {
  const records = await readInstalledRecords(dir)
  const rec = records.find((r) => r.identifier === identifier)
  if (!rec) return undefined
  try {
    return await readInstalledExtension(dir, rec, locale)
  } catch {
    return undefined
  }
}

/** Re-read the installed manifest with NLS localization; falls back to `fallback`. */
async function readInstalledManifestLocalized(
  location: string,
  locale: string | undefined,
  fallback: IExtensionManifest,
): Promise<IExtensionManifest> {
  if (!locale) return fallback
  try {
    return parseManifest(await readManifestJson(location, locale))
  } catch {
    return fallback
  }
}

/**
 * Install a `.vsix` from a path into `dir`. The seven-step on-disk semantics:
 * engine check (when `hostApiVersion` is set) → mkdir → idempotent short-circuit
 * for a local re-install of the same id+version (gallery overwrites by design) →
 * clear obsolete mark → extract to a temp dir + rename-then-delete the target +
 * atomic rename into place → write `extensions.json`.
 */
export async function installVsix(
  dir: string,
  vsixPath: string,
  opts: InstallVsixOptions,
): Promise<InstalledExtension> {
  const manifest = readVsixManifest(vsixPath)
  const { source, galleryMetadata, hostApiVersion, locale, logger } = opts

  if (hostApiVersion !== undefined && !satisfies(hostApiVersion, manifest.engines.universe)) {
    throw new Error(
      localize(
        'extManagement.error.engineMismatch',
        'The extension requires universe {required}, host API is {actual}.',
        { required: manifest.engines.universe, actual: hostApiVersion },
      ),
    )
  }

  const id = extensionId(manifest)
  const version = manifest.version
  assertSafeFolderSegment('identifier', id)
  assertSafeFolderSegment('version', version)
  const location = folderName(id, version)
  const targetDir = path.join(dir, location)

  await fs.mkdir(dir, { recursive: true })

  // Idempotent for a local .vsix: same id+version already on disk → return it.
  // Gallery reinstalls deliberately fall through and overwrite: a dev rebuild
  // keeps the version but changes dist/, and the user clicking reinstall expects
  // the new bits, not a short-circuit to the stale folder.
  const records = await readInstalledRecords(dir)
  const existing = records.find((r) => r.identifier === id && r.version === version)
  if (source === 'vsix' && existing && (await pathExists(targetDir))) {
    logger?.info(`extension ${id}@${version} already installed`)
    return {
      record: existing,
      location: targetDir,
      manifest: await readInstalledManifestLocalized(targetDir, locale, manifest),
    }
  }

  // Clear any obsolete mark on the target folder before writing into it.
  await clearObsolete(dir, location)

  const tmpDir = path.join(dir, `.${randomUUID()}.tmp`)
  try {
    await fs.mkdir(tmpDir, { recursive: true })
    await extractVsix(vsixPath, tmpDir)
    // A stale folder (same-version overwrite) is renamed out of the way before
    // the atomic rename-in, so a concurrent host rescan can't re-adopt it.
    await deleteExtensionFolder(dir, location)
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

  logger?.info(`installed extension ${id}@${version} from ${source}`)
  return {
    record,
    location: targetDir,
    manifest: await readInstalledManifestLocalized(targetDir, locale, manifest),
  }
}

/**
 * Uninstall by identifier: drop the record, then rename-then-delete the folder.
 * When even the rename fails (folder locked), fall back to an `.obsolete` mark so
 * the next startup sweep removes it. Returns true when a record was removed,
 * false when the identifier wasn't installed.
 */
export async function uninstallExtension(
  dir: string,
  identifier: string,
  logger?: ExtensionEngineLogger,
): Promise<boolean> {
  const records = await readInstalledRecords(dir)
  const record = records.find((r) => r.identifier === identifier)
  if (!record) {
    logger?.warn(`uninstall: ${identifier} is not installed`)
    return false
  }

  const next = records.filter((r) => r.identifier !== identifier)
  await writeInstalledRecords(dir, next)

  // Rename-then-delete: the folder name disappears atomically so a host rescan
  // can't re-adopt a half-deleted directory. Only if even the rename fails do we
  // fall back to an obsolete mark for the startup sweep.
  if (await deleteExtensionFolder(dir, record.location)) {
    logger?.info(`uninstalled extension ${identifier}`)
  } else {
    logger?.warn(
      `uninstall ${identifier}: could not remove folder now, marking obsolete for next start`,
    )
    const marks = await readObsolete(dir)
    marks[record.location] = true
    await writeObsolete(dir, marks)
  }
  return true
}

/** Delete every folder still marked obsolete; drop the ones we manage to remove. */
export async function sweepObsolete(dir: string): Promise<void> {
  // Collect any `.vsctmp` folders left by an interrupted rename-then-delete.
  await sweepDeletedFolders(dir)
  const marks = await readObsolete(dir)
  const remaining: ObsoleteMarks = {}
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
