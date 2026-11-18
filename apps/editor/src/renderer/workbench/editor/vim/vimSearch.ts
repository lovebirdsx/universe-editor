/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim-style `/`, `?`, `n`, `N` search. Literal, case-sensitive, single-line
 *  patterns with Vim's wrapscan; the editor is only read line by line so a hit
 *  near the cursor short-circuits instead of materialising the whole buffer.
 *  The last search is module-level (like the unnamed register), so `n` keeps
 *  working after switching editors.
 *--------------------------------------------------------------------------------------------*/

import type { VimPosition, VimSearchDirection, VimTextModel } from './vimTypes.js'

export type VimSearchSource = Pick<VimTextModel, 'getLineCount' | 'getLineContent'>

export interface VimSearchOptions {
  readonly direction: VimSearchDirection
  /** Number of matches to walk; `n`/`N` and `3/foo` pass the typed count. */
  readonly count?: number
}

export interface VimSearchMatch {
  /** 1-based line. */
  readonly line: number
  /** 1-based column, in Monaco's UTF-16 code-unit space. */
  readonly column: number
  /** Whether the match was found by wrapping past the start/end of the file. */
  readonly wrapped: boolean
}

export interface VimLastSearch {
  readonly text: string
  readonly direction: VimSearchDirection
}

let lastSearch: VimLastSearch | null = null

export function getLastVimSearch(): VimLastSearch | null {
  return lastSearch
}

export function setLastVimSearch(next: VimLastSearch): void {
  lastSearch = next
}

export function resetVimSearchForTests(): void {
  lastSearch = null
}

export function searchPrefix(direction: VimSearchDirection): '/' | '?' {
  return direction === 'forward' ? '/' : '?'
}

export function oppositeSearchDirection(direction: VimSearchDirection): VimSearchDirection {
  return direction === 'forward' ? 'backward' : 'forward'
}

/**
 * Vim scans matches without overlap: after a hit it continues at `index + length`,
 * so `aa` in `aaaa` yields columns 1 and 3, never 2. Walking the same greedy
 * sequence is what makes `n` skip the whole current match instead of one
 * character (Vim's `n` on `aaaa` from column 1 goes straight to column 3).
 */
function firstMatchIndex(text: string, query: string, afterIndex: number | null): number {
  let index = text.indexOf(query)
  while (index >= 0) {
    if (afterIndex === null || index > afterIndex) return index
    index = text.indexOf(query, index + query.length)
  }
  return -1
}

/** Greedy match starts before `beforeIndex`; `null` means "the whole line". */
function lastMatchIndex(text: string, query: string, beforeIndex: number | null): number {
  let index = text.indexOf(query)
  let found = -1
  while (index >= 0) {
    if (beforeIndex !== null && index >= beforeIndex) break
    found = index
    index = text.indexOf(query, index + query.length)
  }
  return found
}

/**
 * One search step. The cursor's own match is skipped — `/`, `?`, incsearch and
 * `n`/`N` all behave that way in Vim; a file with a single match wraps back onto
 * it. On the starting line only matches strictly after (forward) or before
 * (backward) the cursor qualify; later lines are matched from their first/last
 * position, and the wrap pass revisits every line from the opposite edge.
 */
function findOnce(
  source: VimSearchSource,
  from: VimPosition,
  query: string,
  direction: VimSearchDirection,
): VimSearchMatch | null {
  const lineCount = source.getLineCount()
  if (lineCount <= 0) return null
  const startLine = Math.max(1, Math.min(lineCount, from.line))
  const cursorIndex = Math.max(0, from.column - 1)

  if (direction === 'forward') {
    for (let line = startLine; line <= lineCount; line++) {
      const index = firstMatchIndex(
        source.getLineContent(line),
        query,
        line === startLine ? cursorIndex : null,
      )
      if (index >= 0) return { line, column: index + 1, wrapped: false }
    }
    for (let line = 1; line <= startLine; line++) {
      const index = firstMatchIndex(source.getLineContent(line), query, null)
      if (index >= 0) return { line, column: index + 1, wrapped: true }
    }
    return null
  }

  for (let line = startLine; line >= 1; line--) {
    const index = lastMatchIndex(
      source.getLineContent(line),
      query,
      line === startLine ? cursorIndex : null,
    )
    if (index >= 0) return { line, column: index + 1, wrapped: false }
  }
  for (let line = lineCount; line >= startLine; line--) {
    const index = lastMatchIndex(source.getLineContent(line), query, null)
    if (index >= 0) return { line, column: index + 1, wrapped: true }
  }
  return null
}

/**
 * Walk `count` matches. Repeated start positions mean the remaining steps cycle
 * through the same matches, so the loop is detected and the rest is reduced
 * modulo the cycle — `9999n` in a one-match file must not rescan the buffer
 * 9999 times. There is no artificial step cap: a count beyond the cycle is
 * resolved exactly instead of being silently truncated.
 */
export function findVimMatch(
  source: VimSearchSource,
  from: VimPosition,
  query: string,
  options: VimSearchOptions,
): VimSearchMatch | null {
  if (query.length === 0 || source.getLineCount() <= 0) return null
  const steps = Math.max(1, options.count ?? 1)
  const seen = new Map<string, number>()
  let position = from
  let match: VimSearchMatch | null = null
  let wrapped = false
  let done = 0

  const step = (): VimSearchMatch | null => {
    const next = findOnce(source, position, query, options.direction)
    if (next === null) return null
    wrapped = wrapped || next.wrapped
    position = { line: next.line, column: next.column }
    done++
    return next
  }

  while (done < steps) {
    const key = `${position.line}:${position.column}`
    const previous = seen.get(key)
    if (previous !== undefined) {
      const cycle = done - previous
      const remaining = (steps - done) % cycle
      for (let index = 0; index < remaining; index++) {
        const next = step()
        if (next === null) return null
        match = next
      }
      break
    }
    seen.set(key, done)
    const next = step()
    if (next === null) return null
    match = next
  }

  return match === null ? null : { ...match, wrapped }
}
