/**
 * Which files inside an extension directory belong in its shipped payload —
 * the single source of truth shared by two consumers that must never drift:
 *   - runtime staging (`scripts/release/runtime-resources.mjs`) copies these
 *     into the packaged app for built-in extensions;
 *   - VSIX packing (`createVsix`) zips exactly these under `extension/**`.
 *
 * The rule mirrors npm's `files` field: `package.json` is always included, plus
 * either the manifest's `files[]` (normalized) or a `dist` default when the
 * extension has a `main`. Entries are validated to stay inside the extension.
 */
import type { IExtensionManifest } from '@universe-editor/extensions-common'

/** Manifest shape we read here — a permissive subset of the full manifest. */
export interface IPackageFilesManifest {
  readonly main?: string
  readonly files?: readonly string[]
}

/**
 * Normalize one `files[]` entry to a repo-relative posix path and reject any
 * attempt to escape the extension directory (absolute, drive-qualified, `..`)
 * or use a glob — packaging copies literal files/dirs only.
 */
export function normalizePackageFileEntry(entry: unknown): string {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error(`Invalid package files entry: ${String(entry)}`)
  }
  let normalized = entry
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3)
  if (
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Package files entry must stay inside the extension: ${entry}`)
  }
  if (/[*?[\]{}]/.test(normalized)) {
    throw new Error(`Package files entry must be a literal file or directory: ${entry}`)
  }
  return normalized
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * The relative paths (files or directories) that make up an extension's
 * payload. Always includes `package.json`; adds the manifest `files[]` when
 * present, otherwise defaults to `dist` if the extension has a `main`.
 */
export function extensionPackageFiles(
  manifest: IPackageFilesManifest | IExtensionManifest,
): string[] {
  const files = (manifest as IPackageFilesManifest).files
  const explicitFiles = Array.isArray(files) ? files.map(normalizePackageFileEntry) : null
  const defaultFiles = manifest.main ? ['dist'] : []
  return unique(['package.json', ...(explicitFiles ?? defaultFiles)])
}
