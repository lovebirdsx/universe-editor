/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads/writes `<userExtensions>/extensions.json` — the installed-extensions
 *  manifest — plus `<userExtensions>/.obsolete`, the "delete on next start" marker
 *  used to work around Windows file locks (a running extension's files can't be
 *  removed immediately). Mirrors VSCode's extensions.json + .obsolete scheme.
 *
 *  All reads tolerate a missing / malformed file by returning empty: a corrupt
 *  manifest must degrade to "nothing installed", never crash startup.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type {
  ExtensionInstallSource,
  IExtensionGalleryMetadata,
} from '../../../shared/ipc/extensionManagementService.js'

/**
 * Suffix for a folder that has been renamed out of the way for deletion. The
 * extension scanner ignores these, so a slow / retried `rm` can't be re-adopted
 * by a host rescan in the meantime. Mirrors VSCode's `.vsctmp` postfix.
 */
export const DELETED_FOLDER_POSTFIX = '.vsctmp'

/** One entry in `extensions.json` `installed[]`. */
export interface IInstalledExtensionRecord {
  readonly identifier: string
  readonly version: string
  /** Folder name relative to the extensions directory. */
  readonly location: string
  readonly source: ExtensionInstallSource
  readonly installedAt: number
  /** Present for gallery-sourced installs. */
  readonly galleryMetadata?: IExtensionGalleryMetadata
}

interface IExtensionsManifestFile {
  version: 1
  installed: IInstalledExtensionRecord[]
  /** identifier → false when disabled. Absent id ⇒ enabled (the default). */
  enablement?: Record<string, boolean>
}

/** Folder-name → true map of directories pending deletion. */
export type ObsoleteMarks = Record<string, boolean>

const MANIFEST_NAME = 'extensions.json'
const OBSOLETE_NAME = '.obsolete'

function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_NAME)
}
function obsoletePath(dir: string): string {
  return path.join(dir, OBSOLETE_NAME)
}

/** Atomically write JSON (temp file + rename) so readers never see a partial file. */
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, target)
}

/** Read `extensions.json` installed records. Returns [] if absent / malformed. */
export async function readInstalledRecords(dir: string): Promise<IInstalledExtensionRecord[]> {
  return (await readManifestFile(dir)).installed
}

/** Read the whole `extensions.json` (installed + enablement). Empty if absent. */
export async function readManifestFile(dir: string): Promise<{
  installed: IInstalledExtensionRecord[]
  enablement: Record<string, boolean>
}> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestPath(dir), 'utf8'),
    ) as IExtensionsManifestFile
    return {
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
      enablement:
        parsed.enablement && typeof parsed.enablement === 'object' ? parsed.enablement : {},
    }
  } catch {
    return { installed: [], enablement: {} }
  }
}

/**
 * Overwrite `extensions.json` with the given records, preserving the existing
 * enablement map. Creates `dir` if needed.
 */
export async function writeInstalledRecords(
  dir: string,
  records: readonly IInstalledExtensionRecord[],
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const { enablement } = await readManifestFile(dir)
  const file: IExtensionsManifestFile = {
    version: 1,
    installed: [...records],
    ...(Object.keys(enablement).length > 0 ? { enablement } : {}),
  }
  await writeJsonAtomic(manifestPath(dir), file)
}

/** Read the enablement map (identifier → false when disabled). */
export async function readEnablement(dir: string): Promise<Record<string, boolean>> {
  return (await readManifestFile(dir)).enablement
}

/** Overwrite `extensions.json` preserving installed records, updating enablement. */
export async function writeEnablement(
  dir: string,
  enablement: Record<string, boolean>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const { installed } = await readManifestFile(dir)
  const pruned: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(enablement)) {
    if (enabled === false) pruned[id] = false // only persist the non-default (disabled) state
  }
  const file: IExtensionsManifestFile = {
    version: 1,
    installed,
    ...(Object.keys(pruned).length > 0 ? { enablement: pruned } : {}),
  }
  await writeJsonAtomic(manifestPath(dir), file)
}

/** Read the `.obsolete` marks. Returns {} if absent / malformed. */
export async function readObsolete(dir: string): Promise<ObsoleteMarks> {
  try {
    const parsed = JSON.parse(await fs.readFile(obsoletePath(dir), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ObsoleteMarks) : {}
  } catch {
    return {}
  }
}

/** Overwrite the `.obsolete` marks (removes the file when empty). */
export async function writeObsolete(dir: string, marks: ObsoleteMarks): Promise<void> {
  const entries = Object.keys(marks).filter((k) => marks[k])
  if (entries.length === 0) {
    await fs.rm(obsoletePath(dir), { force: true })
    return
  }
  await fs.mkdir(dir, { recursive: true })
  const normalized: ObsoleteMarks = {}
  for (const k of entries) normalized[k] = true
  await writeJsonAtomic(obsoletePath(dir), normalized)
}

/**
 * Remove an installed extension's folder from disk with a rename-then-delete so a
 * concurrent host rescan can never re-adopt a half-deleted directory: the folder
 * is first renamed to `<location>.<hash>.vsctmp` (atomic — the original name
 * disappears at once, and the scanner skips `.vsctmp`), then the renamed copy is
 * removed. Returns true on success. If even the rename fails (folder genuinely
 * locked), the caller falls back to an `.obsolete` mark for a startup sweep.
 */
export async function deleteExtensionFolder(dir: string, location: string): Promise<boolean> {
  const target = path.join(dir, location)
  const renamed = path.join(dir, `${location}.${randomUUID().slice(0, 8)}${DELETED_FOLDER_POSTFIX}`)
  try {
    await fs.rename(target, renamed)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true // already gone
    return false
  }
  // The original name is already gone; a failed rm here only leaks a .vsctmp
  // folder, which the startup sweep collects. Treat the uninstall as done.
  await fs.rm(renamed, { recursive: true, force: true }).catch(() => undefined)
  return true
}

/** Delete every `*.vsctmp` folder left behind by an interrupted rename-then-delete. */
export async function sweepDeletedFolders(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith(DELETED_FOLDER_POSTFIX))
      .map((name) =>
        fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined),
      ),
  )
}
