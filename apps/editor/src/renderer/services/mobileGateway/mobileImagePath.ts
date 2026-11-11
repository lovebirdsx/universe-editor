/*---------------------------------------------------------------------------------------------
 *  Markdown-image path resolution for the mobile gateway. The phone asks the PC
 *  for a workspace image, so this module turns the authored `src` into the
 *  trusted on-disk resource: it rejects every scheme except `file:`, confines
 *  the result to the session cwd / same-authority workspace root, and keeps the
 *  remote-session rule (a remote cwd is never read as a local `file:` path).
 *
 *  Pure functions over injected identity: no fs access here. The caller
 *  (`MobileBridgeService`) re-checks the real path after `IFileService.realpath`
 *  to catch symlinks that escape the roots.
 *--------------------------------------------------------------------------------------------*/

import {
  normalizeFsPath,
  REMOTE_SCHEME,
  remoteFsPathToUri,
  URI,
  type IUriIdentityService,
} from '@universe-editor/platform'
import { MAX_IMAGE_SRC_LENGTH } from '@universe-editor/mobile-protocol'
import { mimeTypeForFileName } from '../acp/promptImage.js'

/** Prefix `normalizeFsPath` uses for paths whose `..` escaped the fs root. */
const ESCAPED_PREFIX = '__ESCAPED__'

export interface MobileImagePathContext {
  /** Session cwd (host path string); undefined while a session is still connecting. */
  readonly cwd: string | undefined
  /** remote-ssh authority of the session; undefined = local. */
  readonly authority: string | undefined
  /** The window's workspace folder, used as a fallback root/cwd. */
  readonly workspaceFolder: URI | undefined
  readonly identity: IUriIdentityService
}

export interface ResolvedImagePath {
  readonly uri: URI
  readonly fsPath: string
  readonly mimeType: string
}

/** Same-host roots an image path may live under, most specific first. */
export function resolveImageRoots(context: MobileImagePathContext): readonly string[] {
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    const normalized = normalizeFsPath(value)
    if (normalized.startsWith(ESCAPED_PREFIX)) return
    if (roots.some((root) => context.identity.relativePathUnder(root, normalized) !== null)) {
      return
    }
    roots.push(normalized)
  }
  push(context.cwd)
  const folder = context.workspaceFolder
  if (folder !== undefined && isSameHostFolder(folder, context.authority)) {
    push(folder.fsPath)
  }
  return roots
}

export function isPathUnderAnyRoot(
  fsPath: string,
  roots: readonly string[],
  identity: IUriIdentityService,
): boolean {
  const normalized = normalizeFsPath(fsPath)
  if (normalized.startsWith(ESCAPED_PREFIX)) return false
  return roots.some((root) => identity.relativePathUnder(root, normalized) !== null)
}

/**
 * All plausible workspace resources for a markdown image `src`, deduplicated
 * and most-literal first. Returns `[]` for remote/data URLs, unsupported
 * schemes, non-image extensions and anything outside the allowed roots.
 */
export function resolveMarkdownImageCandidates(
  src: string,
  context: MobileImagePathContext,
): readonly ResolvedImagePath[] {
  const trimmed = src.trim()
  if (trimmed === '' || trimmed.length > MAX_IMAGE_SRC_LENGTH) return []
  if (trimmed.includes('\0')) return []
  if (/^(?:data|blob|https?):/i.test(trimmed)) return []

  const roots = resolveImageRoots(context)
  if (roots.length === 0) return []

  const parsed = parseSourcePath(trimmed, context)
  if (parsed === undefined) return []

  const candidates: ResolvedImagePath[] = []
  const seen = new Set<string>()
  for (const variant of decodeVariants(parsed.rawPath)) {
    const absolute = parsed.absolute ? normalizeFsPath(variant) : joinUnderRoot(roots[0]!, variant)
    if (absolute.startsWith(ESCAPED_PREFIX)) continue
    if (!isPathUnderAnyRoot(absolute, roots, context.identity)) continue
    const mimeType = mimeTypeForFileName(absolute)
    if (mimeType === '') continue
    const key = context.identity.getPathComparisonKey(absolute)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      uri: imagePathToUri(absolute, context.authority),
      fsPath: absolute,
      mimeType,
    })
  }
  return candidates
}

/** Base64 payload → bytes, with a size cap checked before decoding. */
export function decodeBase64Bytes(data: string, maxBytes: number): Uint8Array | undefined {
  const compact = data.replace(/\s+/g, '')
  const payload = compact.startsWith('data:') ? compact.slice(compact.indexOf(',') + 1) : compact
  if (payload === '' || payload.length > Math.ceil((maxBytes * 4) / 3) + 4) return undefined
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) return undefined
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    if (binary.length === 0 || binary.length > maxBytes) return undefined
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

interface ParsedSourcePath {
  readonly rawPath: string
  /** True when the authored path is absolute on the session host. */
  readonly absolute: boolean
}

function parseSourcePath(
  src: string,
  context: MobileImagePathContext,
): ParsedSourcePath | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(src)) {
    // A Windows drive path is a host path only when the session itself is local.
    if (context.authority !== undefined) return undefined
    return { rawPath: src, absolute: true }
  }
  if (/^[a-zA-Z]:(?![\\/])/.test(src)) return undefined
  if (src.startsWith('\\\\') || src.startsWith('//')) return undefined
  if (src.startsWith('/')) {
    return { rawPath: src, absolute: true }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) {
    if (!/^file:/i.test(src) || context.authority !== undefined) return undefined
    const uri = URI.parse(src)
    if (uri.scheme !== 'file') return undefined
    const fsPath = uri.fsPath
    if (fsPath.startsWith('\\\\') || fsPath.startsWith('//')) return undefined
    return { rawPath: fsPath, absolute: true }
  }
  return { rawPath: src, absolute: false }
}

function joinUnderRoot(root: string, relativePath: string): string {
  return normalizeFsPath(`${root}/${relativePath}`)
}

function decodeVariants(rawPath: string): readonly string[] {
  if (!rawPath.includes('%')) return [rawPath]
  try {
    const decoded = decodeURIComponent(rawPath)
    return decoded === rawPath ? [rawPath] : [rawPath, decoded]
  } catch {
    return [rawPath]
  }
}

export function imagePathToUri(fsPath: string, authority: string | undefined): URI {
  return authority !== undefined ? remoteFsPathToUri(fsPath, authority) : URI.file(fsPath)
}

function isSameHostFolder(folder: URI, authority: string | undefined): boolean {
  if (folder.scheme === REMOTE_SCHEME) return (folder.authority || undefined) === authority
  return folder.scheme === 'file' && authority === undefined
}
