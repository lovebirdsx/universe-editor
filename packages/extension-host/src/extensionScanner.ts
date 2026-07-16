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
import {
  satisfies,
  type IExtensionManifest,
  type IResolvedJsonValidation,
} from '@universe-editor/extensions-common'
import { parseManifest } from './manifest.js'
import { loadNlsBundle, localizeManifest } from './nls.js'

export interface IScannedExtension {
  readonly id: string
  readonly manifest: IExtensionManifest
  /** Absolute path to the extension's root folder. */
  readonly extensionPath: string
  /** Absolute path to the entry module, or undefined for a declaration-only extension. */
  readonly mainPath?: string
  /**
   * jsonValidation entries with their `url` already read from disk + parsed into
   * an inline schema. Monaco's JSON worker can't fetch files, so the renderer
   * needs the resolved schema, not a path.
   */
  readonly resolvedJsonValidation?: IResolvedJsonValidation[]
}

function extensionId(manifest: IExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name
}

/**
 * Suffix of a folder renamed out of the way for deletion (see the management
 * service's rename-then-delete). Such a folder still holds a valid manifest, so
 * it must be skipped or a rescan mid-uninstall would re-adopt it. Kept in sync
 * with `DELETED_FOLDER_POSTFIX` in installedExtensionsManifest.ts.
 */
const DELETED_FOLDER_POSTFIX = '.vsctmp'

/**
 * Resolve every `contributes.jsonValidation` entry. Local schema files are read +
 * parsed into an inline schema (Monaco's JSON worker can't fetch files); http(s)
 * urls are passed through verbatim for the renderer to download. A single bad
 * local entry (missing / unparseable) is skipped with a logged error so it never
 * blocks the rest of the extension, mirroring how a bad manifest is skipped.
 */
async function resolveJsonValidation(
  extensionPath: string,
  manifest: IExtensionManifest,
): Promise<IResolvedJsonValidation[]> {
  const entries = manifest.contributes?.jsonValidation ?? []
  const resolved: IResolvedJsonValidation[] = []
  for (const entry of entries) {
    const fileMatch = Array.isArray(entry.fileMatch) ? entry.fileMatch : [entry.fileMatch]
    if (/^https?:\/\//i.test(entry.url)) {
      resolved.push({ fileMatch, url: entry.url })
      continue
    }
    const schemaPath = path.resolve(extensionPath, entry.url)
    try {
      const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'))
      resolved.push({ fileMatch, schema })
    } catch (err) {
      console.error(
        `[ext-host] ${extensionId(manifest)}: skipping jsonValidation "${entry.url}": ${
          (err as Error).message
        }`,
      )
    }
  }
  return resolved
}

async function scanOne(
  extensionPath: string,
  hostApiVersion?: string,
  locale?: string,
): Promise<IScannedExtension> {
  const manifestPath = path.join(extensionPath, 'package.json')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  // Translate `%key%` placeholders against the extension's package.nls*.json
  // before validation, so contributed titles/labels/descriptions reach the
  // renderer already localized (VSCode's package.nls scheme).
  const bundle = await loadNlsBundle(extensionPath, locale)
  const localized = bundle ? localizeManifest(raw, bundle) : raw
  const manifest = parseManifest(localized)
  if (hostApiVersion !== undefined && !satisfies(hostApiVersion, manifest.engines.universe)) {
    throw new Error(`requires universe ${manifest.engines.universe}, host API is ${hostApiVersion}`)
  }
  const resolvedJsonValidation = await resolveJsonValidation(extensionPath, manifest)
  return {
    id: extensionId(manifest),
    manifest,
    extensionPath,
    ...(manifest.main !== undefined
      ? { mainPath: path.resolve(extensionPath, manifest.main) }
      : {}),
    ...(resolvedJsonValidation.length > 0 ? { resolvedJsonValidation } : {}),
  }
}

/**
 * Scan `dir` for extension folders. Returns `[]` if the directory is absent.
 * When `hostApiVersion` is given, extensions whose `engines.universe` range
 * doesn't satisfy it are skipped (logged), same as a malformed manifest.
 * `locale` selects the `package.nls.<locale>.json` bundle for manifest
 * localization (falls back to `package.nls.json`, then to the raw `%key%`).
 */
export async function scanExtensions(
  dir: string,
  hostApiVersion?: string,
  locale?: string,
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
    // A `.vsctmp` folder is a deletion in progress — skip it so a rescan racing
    // an uninstall doesn't re-adopt the extension being removed.
    if (entry.name.endsWith(DELETED_FOLDER_POSTFIX)) continue
    const extensionPath = path.join(dir, entry.name)
    try {
      result.push(await scanOne(extensionPath, hostApiVersion, locale))
    } catch (err) {
      console.error(`[ext-host] skipping ${entry.name}: ${(err as Error).message}`)
    }
  }
  return result
}
