/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  dirtyDiff — folds a line diff (current document vs git HEAD) into the changed
 *  regions VSCode renders in the gutter / overview ruler: contiguous runs of
 *  added / removed lines, classified as added, modified, or deleted.
 *--------------------------------------------------------------------------------------------*/

import { computeLineDiffFromLines } from '../workbench/agents/lineDiff.js'

export type DirtyDiffKind = 'added' | 'modified' | 'deleted'

export interface DirtyDiffRegion {
  /** 1-based line range in the CURRENT document. For 'deleted' it's a single line. */
  readonly startLine: number
  readonly endLine: number
  /**
   * 1-based line range in the HEAD revision this hunk maps to: the lines that were
   * removed / replaced. Empty (`originalEndLine < originalStartLine`) for 'added',
   * where `originalStartLine` then marks the HEAD line the insertion follows.
   * Used to slice HEAD content for the inline peek diff and for revert / stage.
   */
  readonly originalStartLine: number
  readonly originalEndLine: number
  readonly kind: DirtyDiffKind
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/**
 * Split text into the line shape both diff sides must share: EOL-normalized,
 * with the phantom empty line a trailing newline produces dropped. HEAD content
 * goes through this once when cached; the buffer side comes from Monaco's
 * `getLinesContent` and must be aligned via {@link trimTrailingEmptyLine} so a
 * trailing-newline-only difference never shows up as a change.
 */
export function toDiffLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = normalizeEol(text).split('\n')
  return trimTrailingEmptyLine(lines)
}

/** Drop the final empty element (in place) — see {@link toDiffLines}. */
export function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Group the head→current line diff into change hunks and map each to current-doc
 * line numbers. A hunk with both additions and removals is 'modified'; only
 * additions → 'added'; only removals → 'deleted' (anchored to the line preceding
 * the removed block, matching VSCode's deletion triangle).
 */
export function computeDirtyDiffRegions(headText: string, currentText: string): DirtyDiffRegion[] {
  return computeDirtyDiffRegionsFromLines(toDiffLines(headText), toDiffLines(currentText))
}

/**
 * Lines-based entry point: the hot path re-diffs a document on every (throttled)
 * content change, and a huge file must not pay a full-text copy + split per run.
 */
export function computeDirtyDiffRegionsFromLines(
  headLines: readonly string[],
  currentLines: readonly string[],
): DirtyDiffRegion[] {
  const diff = computeLineDiffFromLines(headLines, currentLines)
  const regions: DirtyDiffRegion[] = []
  let curLine = 0
  let origLine = 0
  let i = 0
  while (i < diff.length) {
    if (diff[i]!.kind === 'ctx') {
      curLine++
      origLine++
      i++
      continue
    }
    let adds = 0
    let dels = 0
    let firstAddLine = -1
    let lastAddLine = -1
    let firstDelLine = -1
    let lastDelLine = -1
    while (i < diff.length && diff[i]!.kind !== 'ctx') {
      if (diff[i]!.kind === 'add') {
        curLine++
        adds++
        if (firstAddLine === -1) firstAddLine = curLine
        lastAddLine = curLine
      } else {
        origLine++
        dels++
        if (firstDelLine === -1) firstDelLine = origLine
        lastDelLine = origLine
      }
      i++
    }
    if (adds > 0 && dels > 0) {
      regions.push({
        startLine: firstAddLine,
        endLine: lastAddLine,
        originalStartLine: firstDelLine,
        originalEndLine: lastDelLine,
        kind: 'modified',
      })
    } else if (adds > 0) {
      // Pure insertion: it follows HEAD line `origLine` (0 at top of file). Encode
      // an empty original range (end < start) anchored to that preceding line.
      regions.push({
        startLine: firstAddLine,
        endLine: lastAddLine,
        originalStartLine: origLine,
        originalEndLine: origLine - 1,
        kind: 'added',
      })
    } else {
      const line = Math.max(1, curLine)
      regions.push({
        startLine: line,
        endLine: line,
        originalStartLine: firstDelLine,
        originalEndLine: lastDelLine,
        kind: 'deleted',
      })
    }
  }
  return regions
}

/**
 * Where the dirty-diff marks are painted. Mirrors VSCode's `scm.diffDecorations`
 * setting: one enum controls all three surfaces, there is no per-surface toggle.
 */
export type DirtyDiffDecorationsMode = 'all' | 'gutter' | 'overview' | 'minimap' | 'none'

/** Which of the three surfaces the current `scm.diffDecorations` value enables. */
export interface DirtyDiffDecorationVisibility {
  readonly gutter: boolean
  readonly overview: boolean
  readonly minimap: boolean
}

/** Theme color ids for the minimap marks, per change kind (VSCode parity ids). */
export const DIRTY_DIFF_MINIMAP_COLOR_IDS: Readonly<Record<DirtyDiffKind, string>> = {
  added: 'minimapGutter.addedBackground',
  modified: 'minimapGutter.modifiedBackground',
  deleted: 'minimapGutter.deletedBackground',
}

/** Theme color ids for the overview ruler marks, per change kind. */
export const DIRTY_DIFF_OVERVIEW_RULER_COLOR_IDS: Readonly<Record<DirtyDiffKind, string>> = {
  added: 'editorOverviewRuler.addedForeground',
  modified: 'editorOverviewRuler.modifiedForeground',
  deleted: 'editorOverviewRuler.deletedForeground',
}

/** Resolved CSS colors for one change kind. Always concrete hex — see {@link buildDirtyDiffDecorationSpec}. */
export interface DirtyDiffDecorationColors {
  readonly overviewRuler: string
  readonly minimap: string
}

export type DirtyDiffDecorationColorsByKind = Readonly<
  Record<DirtyDiffKind, DirtyDiffDecorationColors>
>

/**
 * A monaco-free description of one region's decoration. The caller turns it into
 * `IModelDecorationOptions` and supplies the monaco position enums, so this stays
 * testable without loading monaco.
 */
export interface DirtyDiffDecorationSpec {
  readonly isWholeLine: boolean
  readonly linesDecorationsClassName?: string
  readonly overviewRulerColor?: string
  readonly minimapColor?: string
}

/** `scm.diffDecorations` → per-surface flags. An unset / unknown value means `'all'`. */
export function resolveDirtyDiffDecorationsVisibility(
  mode: DirtyDiffDecorationsMode | undefined,
): DirtyDiffDecorationVisibility {
  switch (mode) {
    case 'gutter':
      return { gutter: true, overview: false, minimap: false }
    case 'overview':
      return { gutter: false, overview: true, minimap: false }
    case 'minimap':
      return { gutter: false, overview: false, minimap: true }
    case 'none':
      return { gutter: false, overview: false, minimap: false }
    default:
      return { gutter: true, overview: true, minimap: true }
  }
}

/**
 * Build the decoration description for one region.
 *
 * `colors` must hold concrete hex strings. Monaco's standalone theme only knows
 * the `editor*` / `diffEditor*` ids the theme adapter feeds it, so a `ThemeColor`
 * reference to `minimapGutter.*` resolves to nothing; and a non-hex literal like
 * `rgba(...)` silently degrades to solid red in `Color.fromHex`.
 */
export function buildDirtyDiffDecorationSpec(
  kind: DirtyDiffKind,
  colors: DirtyDiffDecorationColors,
  visibility: DirtyDiffDecorationVisibility,
): DirtyDiffDecorationSpec {
  return {
    // VSCode uses isWholeLine:false for deletions (its gutter mark is a glyph);
    // ours is a CSS triangle on a whole-line decoration, and the gutter click
    // that opens the peek hit-tests against it — keep every kind whole-line.
    isWholeLine: true,
    ...(visibility.gutter
      ? { linesDecorationsClassName: `dirty-diff-gutter dirty-diff-gutter-${kind}` }
      : {}),
    ...(visibility.overview ? { overviewRulerColor: colors.overviewRuler } : {}),
    ...(visibility.minimap ? { minimapColor: colors.minimap } : {}),
  }
}

/** The SCM file decoration fields the HEAD-cache invalidation decision reads. */
export interface ScmFileDecorationState {
  readonly letter?: string
}

/** One source-control instance's HEAD state, keyed by its host handle (unique per repo). */
export interface ScmProviderHeadState {
  readonly providerId: string
  readonly headRevision: string | undefined
}

/** The SCM state the invalidation decision reads. */
export interface ScmHeadSnapshot {
  readonly files: ReadonlyMap<string, ScmFileDecorationState>
  readonly heads: ReadonlyMap<number, ScmProviderHeadState>
}

/**
 * Which HEAD-cache slots a refresh must drop. `full` clears everything;
 * `providerIds` clears every slot of the given providers; `paths` clears the
 * given paths across providers. They are not mutually exclusive — apply all.
 */
export interface ScmHeadCacheInvalidation {
  readonly full: boolean
  readonly providerIds: ReadonlySet<string>
  readonly paths: ReadonlySet<string>
}

const EMPTY_PATHS: ReadonlySet<string> = new Set()

/**
 * Decide which HEAD-cache slots an SCM change must invalidate.
 *
 * The invariant this leans on: `git show HEAD:<path>` output is fully determined
 * by `(HEAD commit, path)`. If a provider's HEAD commit is unchanged, no file's
 * HEAD content could have changed — no matter how the working tree / index
 * moved, or whether files appeared / disappeared. So a provider that reports its
 * HEAD revision needs *no* invalidation while that revision is unchanged, and a
 * per-provider full invalidation exactly when it moves (commit / reset / merge /
 * checkout / pull — even when every file's merged status letter stays the same).
 *
 * Providers that do not report a HEAD revision (a non-git SCM provider, or a
 * repo with no commits yet) leave us nothing to compare, so we conservatively
 * fall back to the file-status heuristic below: without the commit we cannot
 * tell a HEAD move apart from a working-tree edit, so it over-invalidates rather
 * than risk a stale diff.
 */
export function computeScmHeadCacheInvalidation(
  prev: ScmHeadSnapshot,
  next: ScmHeadSnapshot,
): ScmHeadCacheInvalidation {
  const providerIds = new Set<string>()
  let needsFileFallback = false

  const handles = new Set([...prev.heads.keys(), ...next.heads.keys()])
  for (const handle of handles) {
    const prevHead = prev.heads.get(handle)
    const nextHead = next.heads.get(handle)
    if (prevHead?.headRevision !== nextHead?.headRevision) {
      const providerId = nextHead?.providerId ?? prevHead?.providerId
      if (providerId) providerIds.add(providerId)
    } else if (nextHead?.headRevision === undefined) {
      needsFileFallback = true
    }
  }

  if (!needsFileFallback) return { full: false, providerIds, paths: EMPTY_PATHS }

  // Conservative fallback for providers that never report a HEAD revision.
  const changed = new Set<string>()
  let disappeared = false
  for (const [key, deco] of prev.files) {
    const cur = next.files.get(key)
    if (cur === undefined) {
      disappeared = true
      changed.add(key)
    } else if (cur.letter !== deco.letter) {
      changed.add(key)
    }
  }
  for (const key of next.files.keys()) {
    if (!prev.files.has(key)) changed.add(key)
  }
  if (changed.size === 0 || disappeared) {
    return { full: true, providerIds, paths: EMPTY_PATHS }
  }
  return { full: false, providerIds, paths: changed }
}
