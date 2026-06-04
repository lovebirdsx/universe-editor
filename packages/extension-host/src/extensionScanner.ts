/**
 * Built-in extension scanner. Walks a directory of extension folders, validates
 * each `package.json`, and returns the typed descriptors the host activates and
 * the renderer translates. A folder with a missing / invalid manifest is skipped
 * (logged to stderr) so one bad extension never blocks the rest.
 *
 * Layout (dev `extensions/`, packaged `resources/extensions/`):
 *   <dir>/<extension>/package.json
 *   <dir>/<extension>/<manifest.main>      e.g. dist/extension.js
 */
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import { satisfies, type IExtensionManifest } from '@universe-editor/extensions-common'
import { parseManifest } from './manifest.js'

export interface IScannedExtension {
  readonly id: string
  readonly manifest: IExtensionManifest
  /** Absolute path to the extension's root folder. */
  readonly extensionPath: string
  /** Absolute path to the entry module, or undefined for a declaration-only extension. */
  readonly mainPath?: string
}

function extensionId(manifest: IExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name
}

async function scanOne(extensionPath: string, hostApiVersion?: string): Promise<IScannedExtension> {
  const manifestPath = path.join(extensionPath, 'package.json')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  const manifest = parseManifest(raw)
  if (hostApiVersion !== undefined && !satisfies(hostApiVersion, manifest.engines.universe)) {
    throw new Error(`requires universe ${manifest.engines.universe}, host API is ${hostApiVersion}`)
  }
  return {
    id: extensionId(manifest),
    manifest,
    extensionPath,
    ...(manifest.main !== undefined
      ? { mainPath: path.resolve(extensionPath, manifest.main) }
      : {}),
  }
}

/**
 * Scan `dir` for extension folders. Returns `[]` if the directory is absent.
 * When `hostApiVersion` is given, extensions whose `engines.universe` range
 * doesn't satisfy it are skipped (logged), same as a malformed manifest.
 */
export async function scanExtensions(
  dir: string,
  hostApiVersion?: string,
): Promise<IScannedExtension[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const result: IScannedExtension[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const extensionPath = path.join(dir, entry.name)
    try {
      result.push(await scanOne(extensionPath, hostApiVersion))
    } catch (err) {
      console.error(`[ext-host] skipping ${entry.name}: ${(err as Error).message}`)
    }
  }
  return result
}
