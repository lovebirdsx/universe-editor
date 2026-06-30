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

/** True for `C:\…`, `C:/…`, or a leading `/` (POSIX absolute). */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('/')
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
  if (isAbsolutePath(rawPath)) return [URI.file(rawPath)]

  // Normalize separators so a Windows-style `a\b.ts` joins correctly.
  const rel = rawPath.replace(/\\/g, '/')
  const out: URI[] = []
  const seen = new Set<string>()
  const push = (uri: URI): void => {
    const key = uri.toString()
    if (seen.has(key)) return
    seen.add(key)
    out.push(uri)
  }
  if (baseDir) push(URI.joinPath(baseDir, rel))
  if (workspaceRoot) push(URI.joinPath(workspaceRoot, rel))
  return out
}

/**
 * Search pattern for the fuzzy fallback / Go to File prefill: the path with
 * leading `./` and `../` segments stripped (they don't help a name search) and
 * separators normalized to `/`.
 */
export function searchPatternFor(rawPath: string): string {
  return rawPath
    .split(/[/\\]/)
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .join('/')
}
