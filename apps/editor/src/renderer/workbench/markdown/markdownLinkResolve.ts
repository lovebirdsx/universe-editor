/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for resolving a file path clicked inside rendered markdown. Kept
 *  free of React / services so the candidate-ordering and search-pattern rules
 *  can be unit-tested in isolation; the hook (useMarkdownFileLink) wires these to
 *  IFileService / IFileSearchService / IQuickAccessController.
 *
 *  Resolution strategy (mirrors how an editor opens a path the user typed):
 *    1. Try concrete candidates in order — an absolute path, the path relative to
 *       the markdown source's directory, then relative to the workspace root.
 *       The first that exists on disk opens immediately (fast path: no search).
 *    2. Only if none exist, fall back to a workspace file search. One hit opens
 *       directly; several hits hand off to Go to File (prefilled) so the user
 *       picks; zero hits surfaces a "not found" notification.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { splitFilePathLocation } from '../../services/acp/filePathLink.js'

/** True for `C:\…`, `C:/…`, or a leading `/` (POSIX absolute). */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('/')
}

function decodeMarkdownLinkPath(rawPath: string): string {
  if (!rawPath.includes('%')) return rawPath
  try {
    return decodeURIComponent(rawPath)
  } catch {
    return rawPath
  }
}

function markdownLinkPathVariants(rawPath: string): readonly string[] {
  const decoded = decodeMarkdownLinkPath(rawPath)
  return decoded === rawPath ? [rawPath] : [decoded, rawPath]
}

/**
 * Ordered, de-duplicated list of concrete URIs to probe for {@link rawPath}.
 * Absolute paths yield a single candidate; relative paths are resolved against
 * the markdown source directory first (closest context wins), then the workspace
 * root — matching how a path written in a doc is usually meant.
 */
export function markdownLinkCandidates(
  rawPath: string,
  baseDir: URI | undefined,
  workspaceRoot: URI | undefined,
): URI[] {
  const out: URI[] = []
  const seen = new Set<string>()
  const push = (uri: URI): void => {
    const key = uri.toString()
    if (seen.has(key)) return
    seen.add(key)
    out.push(uri)
  }
  for (const path of markdownLinkPathVariants(rawPath)) {
    if (isAbsolutePath(path)) {
      push(URI.file(path))
      continue
    }
    // Normalize separators so a Windows-style `a\b.ts` joins correctly.
    const rel = path.replace(/\\/g, '/')
    if (baseDir) push(URI.joinPath(baseDir, rel))
    if (workspaceRoot) push(URI.joinPath(workspaceRoot, rel))
  }
  return out
}

/**
 * Search pattern for the fuzzy fallback / Go to File prefill: the path with
 * leading `./` and `../` segments stripped (they don't help a name search) and
 * separators normalized to `/`.
 */
export function searchPatternFor(rawPath: string): string {
  return decodeMarkdownLinkPath(rawPath)
    .split(/[/\\]/)
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .join('/')
}

export interface FileUriLinkTarget {
  readonly path: string
  readonly line?: number
  readonly col?: number
  readonly endLine?: number
  readonly fragment?: string
}

/**
 * Split a `file://` href into the same shape {@link splitFilePathLocation}
 * produces for plain path links, so a `file:` link flows through the exact
 * same open pipeline (directory → folder window, markdown → preview, other →
 * editor resolver) instead of being force-fed to the editor resolver. `URI.parse`
 * already percent-decodes the path; a `:line:col` suffix rides on the fsPath.
 */
export function fileUriLinkTarget(href: string): FileUriLinkTarget | undefined {
  let uri: URI
  try {
    uri = URI.parse(href)
  } catch {
    return undefined
  }
  if (uri.scheme !== 'file') return undefined
  // 本机路径：仅处理 file: href，不涉及远端 scheme。
  const fsPath = uri.fsPath
  if (fsPath.length === 0) return undefined
  const { path, line, col, endLine } = splitFilePathLocation(fsPath)
  return {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(uri.fragment.length > 0 ? { fragment: uri.fragment } : {}),
  }
}
