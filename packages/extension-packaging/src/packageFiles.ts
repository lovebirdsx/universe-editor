/**
 * Which files inside an extension directory belong in its shipped payload —
 * the single source of truth shared by two consumers that must never drift:
 *   - runtime staging (`scripts/release/runtime-resources.mjs`) copies these
 *     into the packaged app for built-in extensions;
 *   - VSIX packing (`createVsix`) zips exactly these under `extension/**`.
 *
 * The rule mirrors npm's `files` field: `package.json` is always included, plus
 * either the manifest's `files[]` (normalized) or a `dist` default when the
 * extension has a `main` or ships trusted views. Entries are validated to stay inside the extension.
 */
import type { IExtensionManifest } from '@universe-editor/extension-manifest'

/** Manifest shape we read here — a permissive subset of the full manifest. */
export interface IPackageFilesManifest {
  readonly main?: string
  readonly files?: readonly string[]
  /** Only the presence of trusted views matters here (their `entry` lives under the payload). */
  readonly contributes?: { readonly trustedViews?: readonly unknown[] }
}

/** A `files` entry that names the extension root itself (`.` / `./`). */
const ROOT_PACKAGE_ENTRY = '.'

/**
 * Normalize one path for whitelist comparison: backslashes → `/`, drop a `./`
 * prefix and trailing `/` or `/**`. `.` / `./` (and anything normalizing to
 * nothing) mean the extension root. Shared by both sides of
 * {@link isPathCoveredByPackageFiles} so an entry and the checked path cannot
 * drift apart.
 */
function normalizePackagePath(value: string): string {
  let normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3)
  normalized = normalized.replace(/\/+$/, '')
  return normalized === '' || normalized === '.' ? ROOT_PACKAGE_ENTRY : normalized
}

/**
 * Whether `relativePath` is shipped by a package-files whitelist: either the
 * path itself is listed or it lives under a listed directory. Both sides use
 * {@link normalizePackagePath}. Case stays significant: VSIX zip paths are
 * matched byte-for-byte by consumers, and Windows' case-insensitive filesystem
 * must not hide a mismatch that breaks on another platform. Used by `uex
 * package` to verify that every `trustedViews[].entry` actually ships.
 */
export function isPathCoveredByPackageFiles(
  packageFiles: readonly string[],
  relativePath: string,
): boolean {
  if (relativePath.trim() === '') return false
  const normalized = normalizePackagePath(relativePath)
  if (normalized === ROOT_PACKAGE_ENTRY) return true
  return packageFiles.some((entry) => {
    const normalizedEntry = normalizePackagePath(entry)
    if (normalizedEntry === ROOT_PACKAGE_ENTRY) return true
    return normalized === normalizedEntry || normalized.startsWith(`${normalizedEntry}/`)
  })
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
  const normalized = normalizePackagePath(entry)
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
  const hasTrustedViews = (manifest.contributes?.trustedViews?.length ?? 0) > 0
  const defaultFiles = manifest.main !== undefined || hasTrustedViews ? ['dist'] : []
  return unique(['package.json', ...(explicitFiles ?? defaultFiles)])
}
