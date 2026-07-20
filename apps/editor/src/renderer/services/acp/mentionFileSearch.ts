/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace file fuzzy search for the @-mention popover. Caches the file
 *  listing per workspace root (TTL = 10s) so repeated keystrokes don't
 *  re-walk the tree on every IPC. The fuzzy match itself is intentionally
 *  simple: a case-insensitive subsequence match favouring shorter / earlier
 *  matches, which is "good enough" without a fuzzy-search dependency.
 *
 *  Returns relative-to-root entries: the absolute fsPath becomes the
 *  resource URI; the workspace-relative path is the display label inserted
 *  after `@` (and the popover detail).
 *--------------------------------------------------------------------------------------------*/

import { URI, type IFileSearchService } from '@universe-editor/platform'
import { compareByScoreThenPath, fuzzyMatchField } from '@universe-editor/workbench-ui'

export interface MentionFileEntry {
  /** Absolute file:// URI (the value stored on the AcpContentBlock.resource_link). */
  readonly uri: string
  /** Workspace-relative path with forward slashes, e.g. `src/main.ts`. */
  readonly relPath: string
  /** Basename for display, e.g. `main.ts`. */
  readonly name: string
}

/**
 * Exclusion inputs for the workspace walk. `dirNames` prunes big directories
 * during the walk by bare name; `excludeGlobs` applies the full glob set in
 * the main-process search service. Decoupled from DI so this helper stays
 * pure-testable.
 */
export interface MentionFileFilter {
  readonly dirNames: readonly string[]
  readonly excludeGlobs?: readonly string[]
}

const FALLBACK_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo']
const MAX_FILES = 100_000
const CACHE_TTL_MS = 10_000

interface _Cache {
  readonly key: string
  readonly entries: readonly MentionFileEntry[]
  readonly timestamp: number
}
const _cache = new Map<string, _Cache>()

/**
 * Walk the workspace under `root` (cached). Returns at most `MAX_FILES`
 * entries with workspace-relative `relPath`. The cache key is the URI string
 * plus the exclude signature; each entry is normalized to use forward slashes
 * regardless of the host OS so the displayed mention is stable across platforms.
 */
export async function loadWorkspaceFiles(
  root: URI,
  fileSearch: IFileSearchService,
  filter?: MentionFileFilter,
): Promise<readonly MentionFileEntry[]> {
  const dirNames = filter ? filter.dirNames : FALLBACK_IGNORE_DIRS
  const excludeGlobs = filter?.excludeGlobs ?? []
  const key = root.toString() + '|' + dirNames.join(',') + '|' + excludeGlobs.join(',')
  const now = Date.now()
  const cached = _cache.get(key)
  if (cached && now - cached.timestamp < CACHE_TTL_MS) return cached.entries

  const complete = await fileSearch.search({
    root,
    pattern: '',
    matchAll: true,
    excludes: excludeGlobs,
    ignore: dirNames,
    maxResults: MAX_FILES,
  })
  const entries = complete.results.map((match) => {
    return {
      uri: match.resource.toString(),
      relPath: match.relativePath,
      name: match.basename,
    }
  })
  _cache.set(key, { key, entries, timestamp: now })
  return entries
}

/** Invalidate the cache — exposed for tests and for explicit refresh actions. */
export function invalidateMentionFileCache(root?: URI): void {
  if (!root) {
    _cache.clear()
    return
  }
  // Keys are `<root>|<dirNameSignature>`, so clear every variant for this root.
  const prefix = root.toString() + '|'
  for (const key of [..._cache.keys()]) {
    if (key.startsWith(prefix)) _cache.delete(key)
  }
}

/**
 * Fuzzy-match `entries` against the user's query. Empty query returns the
 * first `limit` entries unchanged. Each match is scored by:
 *   - prefix match on basename → highest priority
 *   - substring match on basename → next
 *   - subsequence match on relPath → lowest
 * Entries that don't match at all are filtered out.
 */
export function filterMentionFiles(
  entries: readonly MentionFileEntry[],
  query: string,
  limit = 30,
): readonly MentionFileEntry[] {
  if (!query) return entries.slice(0, limit)
  const q = query.toLowerCase()
  const scored: { entry: MentionFileEntry; score: number }[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    const rel = entry.relPath.toLowerCase()
    let score = -1
    if (name.startsWith(q)) score = 1000 - name.length
    else if (name.includes(q)) score = 500 - name.length
    else if (rel.includes(q)) score = 200 - rel.length
    else if (fuzzyMatchField(entry.relPath, query)) score = 50
    if (score >= 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => compareByScoreThenPath(a.score, b.score, a.entry.relPath, b.entry.relPath))
  return scored.slice(0, limit).map((s) => s.entry)
}
