/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim-style `/`, `?`, `n`, `N` search. Single-line patterns with Vim's
 *  wrapscan; the editor is only read line by line so a hit near the cursor
 *  short-circuits instead of materialising the whole buffer. `/` and `?` match
 *  literal substrings; `*` / `#` add word boundaries (Vim's `\<...\>`), and that
 *  mode is stored so `n` / `N` replay it. Case sensitivity follows Vim's
 *  `smartcase` by default and can be overridden per search with `\c` / `\C` or
 *  the Aa toggle; `n`/`N` replay the stored effective setting. The last search
 *  is module-level (like the unnamed register), so `n` keeps working after
 *  switching editors.
 *--------------------------------------------------------------------------------------------*/

import type { VimPosition, VimSearchDirection, VimTextModel } from './vimTypes.js'

export type VimSearchSource = Pick<VimTextModel, 'getLineCount' | 'getLineContent'>

export type VimSearchCaseMode = 'smart' | 'sensitive' | 'insensitive'

export type VimSearchCaseOverride = 'sensitive' | 'insensitive' | null

/** Where the effective case sensitivity came from. */
export type VimSearchCaseSource = 'marker' | 'user' | 'default'

export interface VimSearchPattern {
  /** The real pattern, with `\c` / `\C` markers stripped. */
  readonly text: string
  readonly caseSensitive: boolean
  readonly caseMode: VimSearchCaseMode
  readonly caseSource: VimSearchCaseSource
  /** The last `\c` / `\C` marker typed in the raw input, if any. */
  readonly marker: 'c' | 'C' | null
}

export interface VimSearchOptions {
  readonly direction: VimSearchDirection
  /** Number of matches to walk; `n`/`N` and `3/foo` pass the typed count. */
  readonly count?: number
  /** Defaults to true so the pure matcher keeps its original behavior. */
  readonly caseSensitive?: boolean
  /** `*` / `#` match whole words only (Vim's `\<...\>`); `/` / `?` leave it false. */
  readonly wholeWord?: boolean
}

export interface VimSearchMatch {
  /** 1-based line. */
  readonly line: number
  /** 1-based column, in Monaco's UTF-16 code-unit space. */
  readonly column: number
  /** Whether the match was found by wrapping past the start/end of the file. */
  readonly wrapped: boolean
}

export interface VimSearchSpan {
  /** 1-based line. */
  readonly line: number
  /** 1-based column, in Monaco's UTF-16 code-unit space. */
  readonly column: number
  /** Length in UTF-16 code units. */
  readonly length: number
}

export interface VimFindAllOptions {
  readonly caseSensitive: boolean
  readonly wholeWord?: boolean
  readonly maxMatches?: number
  readonly maxLines?: number
  readonly maxLineLength?: number
}

export interface VimFindAllResult {
  readonly matches: readonly VimSearchSpan[]
  readonly truncated: boolean
}

/** Bounds for `hlsearch` scans; large files keep a predictable cost. */
export const VIM_SEARCH_HIGHLIGHT_LIMITS = {
  maxMatches: 2000,
  maxLines: 20000,
  maxLineLength: 20000,
} as const

export interface VimLastSearch {
  readonly text: string
  readonly direction: VimSearchDirection
  /** Effective case sensitivity at commit time; `n`/`N` must not re-derive it. */
  readonly caseSensitive: boolean
  /** `*` / `#` searches stay whole-word when replayed by `n` / `N`. */
  readonly wholeWord: boolean
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
 * Split the raw input into the literal pattern and the optional case marker.
 * Vim treats `\c`/`\C` as part of the pattern, but our matching is literal, so
 * they are removed from the matched text while staying in the input box.
 * `\\` is an escaped backslash (`C:\\config` searches `C:\config` without the
 * second backslash turning into a `\c` marker).
 */
export function stripVimCaseMarkers(raw: string): {
  readonly text: string
  readonly marker: 'c' | 'C' | null
} {
  let text = ''
  let marker: 'c' | 'C' | null = null
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!
    const next = raw[index + 1]
    if (char === '\\' && next === '\\') {
      text += '\\'
      index++
      continue
    }
    if (char === '\\' && (next === 'c' || next === 'C')) {
      marker = next
      index++
      continue
    }
    text += char
  }
  return { text, marker }
}

const UPPERCASE_PATTERN = /\p{Lu}|\p{Lt}/u

/**
 * Resolve the effective case sensitivity. Precedence: an explicit `\c`/`\C`
 * marker > the Aa toggle for this search > the configured default. `smart`
 * means case-sensitive only when the pattern itself contains an uppercase
 * letter, matching Vim's `smartcase`.
 */
export function resolveVimSearchPattern(
  raw: string,
  defaultMode: VimSearchCaseMode,
  override: VimSearchCaseOverride = null,
): VimSearchPattern {
  const { text, marker } = stripVimCaseMarkers(raw)
  let caseSensitive: boolean
  let caseSource: VimSearchCaseSource

  if (marker !== null) {
    caseSensitive = marker === 'C'
    caseSource = 'marker'
  } else if (override !== null) {
    caseSensitive = override === 'sensitive'
    caseSource = 'user'
  } else if (defaultMode === 'sensitive') {
    caseSensitive = true
    caseSource = 'default'
  } else if (defaultMode === 'insensitive') {
    caseSensitive = false
    caseSource = 'default'
  } else {
    caseSensitive = UPPERCASE_PATTERN.test(text)
    caseSource = 'default'
  }

  return { text, caseSensitive, caseMode: defaultMode, caseSource, marker }
}

interface LineMatch {
  readonly index: number
  readonly length: number
}

interface VimLineMatcher {
  next(text: string, fromIndex: number): LineMatch | null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Vim keyword characters for `*` / `#` word boundaries. Kept in sync with the
 * cursor-word extraction in `vimEditorController.searchWord`; both use this
 * predicate so `foo` never matches inside `fooBar` while `$foo` stays one word.
 */
const VIM_KEYWORD_CHAR = /[A-Za-z0-9_$]/

export function isVimKeywordChar(char: string | undefined): boolean {
  return char !== undefined && VIM_KEYWORD_CHAR.test(char)
}

function isWholeWordAt(text: string, index: number, length: number): boolean {
  return !isVimKeywordChar(text[index - 1]) && !isVimKeywordChar(text[index + length])
}

/**
 * Case-insensitive matching uses a `giu` regex on the original line instead of
 * `toLowerCase()`: `match.index` stays in UTF-16 code units (the `u` flag does
 * not change indices), while lowercasing can change a string's length (`İ`),
 * which would corrupt Monaco columns.
 */
function createLineMatcher(
  query: string,
  caseSensitive: boolean,
  wholeWord = false,
): VimLineMatcher {
  if (caseSensitive) {
    return {
      next(text, fromIndex) {
        let index = text.indexOf(query, fromIndex)
        while (index >= 0) {
          if (!wholeWord || isWholeWordAt(text, index, query.length)) {
            return { index, length: query.length }
          }
          index = text.indexOf(query, index + Math.max(1, query.length))
        }
        return null
      },
    }
  }

  const pattern = new RegExp(escapeRegExp(query), 'giu')
  return {
    next(text, fromIndex) {
      pattern.lastIndex = fromIndex
      let match = pattern.exec(text)
      while (match !== null) {
        const length = Math.max(1, match[0].length)
        if (!wholeWord || isWholeWordAt(text, match.index, length)) {
          return { index: match.index, length }
        }
        match = pattern.exec(text)
      }
      return null
    },
  }
}

/**
 * Vim scans matches without overlap: after a hit it continues at `index + length`,
 * so `aa` in `aaaa` yields columns 1 and 3, never 2. Walking the same greedy
 * sequence is what makes `n` skip the whole current match instead of one
 * character (Vim's `n` on `aaaa` from column 1 goes straight to column 3).
 */
function firstMatchIndex(text: string, matcher: VimLineMatcher, afterIndex: number | null): number {
  let hit = matcher.next(text, 0)
  while (hit !== null) {
    if (afterIndex === null || hit.index > afterIndex) return hit.index
    hit = matcher.next(text, hit.index + hit.length)
  }
  return -1
}

/** Greedy match starts before `beforeIndex`; `null` means "the whole line". */
function lastMatchIndex(text: string, matcher: VimLineMatcher, beforeIndex: number | null): number {
  let hit = matcher.next(text, 0)
  let found = -1
  while (hit !== null) {
    if (beforeIndex !== null && hit.index >= beforeIndex) break
    found = hit.index
    hit = matcher.next(text, hit.index + hit.length)
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
  matcher: VimLineMatcher,
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
        matcher,
        line === startLine ? cursorIndex : null,
      )
      if (index >= 0) return { line, column: index + 1, wrapped: false }
    }
    for (let line = 1; line <= startLine; line++) {
      const index = firstMatchIndex(source.getLineContent(line), matcher, null)
      if (index >= 0) return { line, column: index + 1, wrapped: true }
    }
    return null
  }

  for (let line = startLine; line >= 1; line--) {
    const index = lastMatchIndex(
      source.getLineContent(line),
      matcher,
      line === startLine ? cursorIndex : null,
    )
    if (index >= 0) return { line, column: index + 1, wrapped: false }
  }
  for (let line = lineCount; line >= startLine; line--) {
    const index = lastMatchIndex(source.getLineContent(line), matcher, null)
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
  const matcher = createLineMatcher(
    query,
    options.caseSensitive ?? true,
    options.wholeWord === true,
  )
  const steps = Math.max(1, options.count ?? 1)
  const seen = new Map<string, number>()
  let position = from
  let match: VimSearchMatch | null = null
  let wrapped = false
  let done = 0

  const step = (): VimSearchMatch | null => {
    const next = findOnce(source, position, matcher, options.direction)
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

/**
 * Collect every non-overlapping match for `hlsearch`. The scan is bounded so a
 * huge or minified file cannot stall the renderer on every edit; `truncated`
 * reports whether any bound was hit.
 */
export function findAllVimMatches(
  source: VimSearchSource,
  query: string,
  options: VimFindAllOptions,
): VimFindAllResult {
  if (query.length === 0) return { matches: [], truncated: false }
  const lineCount = source.getLineCount()
  if (lineCount <= 0) return { matches: [], truncated: false }

  const maxMatches = options.maxMatches ?? VIM_SEARCH_HIGHLIGHT_LIMITS.maxMatches
  const maxLines = options.maxLines ?? VIM_SEARCH_HIGHLIGHT_LIMITS.maxLines
  const maxLineLength = options.maxLineLength ?? VIM_SEARCH_HIGHLIGHT_LIMITS.maxLineLength
  const matcher = createLineMatcher(query, options.caseSensitive, options.wholeWord === true)
  const matches: VimSearchSpan[] = []
  const scanLines = Math.min(lineCount, maxLines)
  let truncated = scanLines < lineCount

  for (let line = 1; line <= scanLines; line++) {
    const text = source.getLineContent(line)
    if (text.length > maxLineLength) {
      truncated = true
      continue
    }
    let hit = matcher.next(text, 0)
    while (hit !== null) {
      matches.push({ line, column: hit.index + 1, length: hit.length })
      if (matches.length >= maxMatches) return { matches, truncated: true }
      hit = matcher.next(text, hit.index + hit.length)
    }
  }

  return { matches, truncated }
}
