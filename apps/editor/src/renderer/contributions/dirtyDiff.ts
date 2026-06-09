/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  dirtyDiff — folds a line diff (current document vs git HEAD) into the changed
 *  regions VSCode renders in the gutter / overview ruler: contiguous runs of
 *  added / removed lines, classified as added, modified, or deleted.
 *--------------------------------------------------------------------------------------------*/

import { computeLineDiff } from '../workbench/agents/lineDiff.js'

export type DirtyDiffKind = 'added' | 'modified' | 'deleted'

export interface DirtyDiffRegion {
  /** 1-based line range in the CURRENT document. For 'deleted' it's a single line. */
  readonly startLine: number
  readonly endLine: number
  readonly kind: DirtyDiffKind
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/**
 * Group the head→current line diff into change hunks and map each to current-doc
 * line numbers. A hunk with both additions and removals is 'modified'; only
 * additions → 'added'; only removals → 'deleted' (anchored to the line preceding
 * the removed block, matching VSCode's deletion triangle).
 */
export function computeDirtyDiffRegions(headText: string, currentText: string): DirtyDiffRegion[] {
  const diff = computeLineDiff(normalizeEol(headText), normalizeEol(currentText))
  const regions: DirtyDiffRegion[] = []
  let curLine = 0
  let i = 0
  while (i < diff.length) {
    if (diff[i]!.kind === 'ctx') {
      curLine++
      i++
      continue
    }
    let adds = 0
    let dels = 0
    let firstAddLine = -1
    let lastAddLine = -1
    while (i < diff.length && diff[i]!.kind !== 'ctx') {
      if (diff[i]!.kind === 'add') {
        curLine++
        adds++
        if (firstAddLine === -1) firstAddLine = curLine
        lastAddLine = curLine
      } else {
        dels++
      }
      i++
    }
    if (adds > 0 && dels > 0) {
      regions.push({ startLine: firstAddLine, endLine: lastAddLine, kind: 'modified' })
    } else if (adds > 0) {
      regions.push({ startLine: firstAddLine, endLine: lastAddLine, kind: 'added' })
    } else {
      const line = Math.max(1, curLine)
      regions.push({ startLine: line, endLine: line, kind: 'deleted' })
    }
  }
  return regions
}
