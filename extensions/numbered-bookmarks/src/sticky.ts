/**
 * Sticky bookmarks: keep bookmarks pinned to their logical line as the file is
 * edited above them. The platform's `onDidChangeTextDocument` is full-text sync
 * (no edit range), so we diff the previous text against the new one by lines —
 * common-prefix / common-suffix — to recover where lines were inserted or
 * removed, then shift affected bookmarks by the net line delta.
 */

import type { BookmarkStore } from './bookmarks.js'

/** Number of leading lines identical between `a` and `b`. */
function commonPrefixLines(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/** Number of trailing lines identical between `a` and `b`, not overlapping `prefix`. */
function commonSuffixLines(a: readonly string[], b: readonly string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix
  let i = 0
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

export interface LineEdit {
  /** First 0-based line that changed. */
  readonly start: number
  /** Net change in line count (positive = lines added). */
  readonly delta: number
  /** Last 0-based line of the changed region in the OLD text (inclusive). */
  readonly oldEnd: number
}

/** Recover the changed line region between two document snapshots. */
export function diffLines(oldText: string, newText: string): LineEdit | undefined {
  if (oldText === newText) return undefined
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const prefix = commonPrefixLines(a, b)
  const suffix = commonSuffixLines(a, b, prefix)
  const oldEnd = a.length - 1 - suffix
  const delta = b.length - a.length
  return { start: prefix, delta, oldEnd }
}

/**
 * Apply a line edit to every bookmark living in `path`. A bookmark strictly
 * below the changed region shifts by `delta`; a bookmark on a removed line
 * collapses to the edit's start. Returns true if anything moved, so the caller
 * can re-persist / re-decorate.
 */
export function applyLineEdit(store: BookmarkStore, path: string, edit: LineEdit): boolean {
  if (edit.delta === 0) return false
  let changed = false
  for (const [, bookmark] of store.all()) {
    if (bookmark.path !== path) continue
    const line = bookmark.line
    if (line > edit.oldEnd) {
      bookmark.line = line + edit.delta
      changed = true
    } else if (edit.delta < 0 && line > edit.start && line <= edit.oldEnd) {
      bookmark.line = edit.start
      changed = true
    }
  }
  return changed
}
