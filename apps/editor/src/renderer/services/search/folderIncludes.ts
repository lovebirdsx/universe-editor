/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  folderIncludes — build the "files to include" text for Find in Folder.
 *
 *  Mirrors VSCode's resolveResourcesForSearchIncludes (queryBuilder.ts) for a
 *  single-root workspace: every folder becomes a `./<relative-path>` pattern
 *  anchored at the workspace root (matched by the main-side expandIncludeGlob),
 *  and the root itself contributes nothing (a whole-workspace search).
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import { relativeTo, sameUri } from '../explorer/explorerTreeUtils.js'

/** VSCode escapeGlobPattern: make a path segment match literally as a glob. */
export function escapeGlobPattern(path: string): string {
  return path.replace(/([?*[\]])/g, '[$1]')
}

/**
 * The `files to include` text for searching inside `folders`: `./rel/path`
 * entries joined by ', '. The workspace root (and anything outside it) is
 * skipped — searching the root needs no include pattern at all.
 */
export function folderIncludesForSearch(root: URI, folders: readonly URI[]): string {
  const seen = new Set<string>()
  const patterns: string[] = []
  for (const folder of folders) {
    if (sameUri(folder, root)) continue
    const rel = relativeTo(root, folder)
    // relativeTo returns the unchanged path when folder lies outside root;
    // those can't be expressed as a root-anchored `./` pattern.
    if (rel === '' || rel === folder.path) continue
    const pattern = `./${escapeGlobPattern(rel)}`
    if (seen.has(pattern)) continue
    seen.add(pattern)
    patterns.push(pattern)
  }
  return patterns.join(', ')
}
