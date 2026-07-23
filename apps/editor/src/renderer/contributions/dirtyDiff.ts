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
