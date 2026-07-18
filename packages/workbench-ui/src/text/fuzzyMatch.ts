/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared fuzzy / word matching primitives used by every "type to filter"
 *  surface (Go to File quick pick, the `/` slash-command popover, the `@`
 *  mention popover). Pure predicates: they answer "does this text match the
 *  query" — ranking is each caller's concern.
 *--------------------------------------------------------------------------------------------*/

export function fuzzyMatchField(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

/** A contiguous run of matched characters, usable directly as a highlight span. */
export interface FuzzyMatchSpan {
  readonly start: number
  readonly end: number
}

export interface FuzzyScoreResult {
  readonly score: number
  /** Matched character ranges in `text`, merged so adjacent hits form one span. */
  readonly matches: readonly FuzzyMatchSpan[]
}

/** A position starts a new word: at index 0, after a separator, or a camelCase hump. */
function isWordStart(text: string, i: number): boolean {
  if (i <= 0) return true
  const prev = text[i - 1]
  const cur = text[i]
  if (prev === undefined || cur === undefined) return true
  if (isWordSeparator(prev)) return true
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase()
}

function mergeSpans(positions: readonly number[]): FuzzyMatchSpan[] {
  const spans: FuzzyMatchSpan[] = []
  for (const pos of positions) {
    const last = spans[spans.length - 1]
    if (last && last.end === pos) spans[spans.length - 1] = { start: last.start, end: pos + 1 }
    else spans.push({ start: pos, end: pos + 1 })
  }
  return spans
}

/**
 * Score `query` against a single field and report which characters matched.
 * Returns `null` for no match; `{score: 0, matches: []}` for an empty query.
 * Tiers: prefix (1000) beats substring (500) beats loose subsequence (50);
 * within a tier a shorter field ranks higher, and hitting word starts (after a
 * separator or at a camelCase hump) adds a small bonus so e.g. `GetEntityData`
 * outranks `GetDecompressedEntityDatas` for the query `GetEntityData`. The
 * returned `matches` double as highlight ranges, so ranking and highlighting
 * never drift apart. Mirrors VSCode's fuzzy scorer behavior at a smaller scale.
 */
export function fuzzyScore(text: string, query: string): FuzzyScoreResult | null {
  if (!query) return { score: 0, matches: [] }
  const t = text.toLowerCase()
  const q = query.toLowerCase()

  if (t.startsWith(q)) return { score: 1000 - t.length, matches: [{ start: 0, end: q.length }] }

  const subIdx = t.indexOf(q)
  if (subIdx >= 0) {
    const bonus = isWordStart(text, subIdx) ? 1 : 0
    return { score: 500 - t.length + bonus, matches: [{ start: subIdx, end: subIdx + q.length }] }
  }

  const positions: number[] = []
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i)
      qi++
    }
  }
  if (qi !== q.length) return null

  let bonus = 0
  for (const pos of positions) if (isWordStart(text, pos)) bonus++
  return { score: 50 - t.length + bonus, matches: mergeSpans(positions) }
}

/**
 * Relevance score for matching `query` against a single field. Higher is more
 * relevant; -1 means no match. Thin wrapper over {@link fuzzyScore} for callers
 * that only need the number. Mirrors the tiering the @-mention file search uses
 * so every "type to filter" surface orders results consistently.
 */
export function scoreFuzzyMatch(text: string, query: string): number {
  if (!query) return 0
  const result = fuzzyScore(text, query)
  return result ? result.score : -1
}

/**
 * Tie-breaker for fuzzy-ranked file results: sort by score descending, then —
 * when scores are equal — prefer the shorter path so files closer to the root
 * rank above deeply nested ones, falling back to a stable locale order. Mirrors
 * VSCode's `fallbackCompare`, whose first discriminator after score is the
 * label+description length. Without this, an all-basenames-match query like
 * `package.json` degrades to a pure alphabetical order and buries the top-level
 * `apps/editor/package.json` beneath a deep `.runtime-resources/.../package.json`.
 */
export function compareByScoreThenPath(
  scoreA: number,
  scoreB: number,
  pathA: string,
  pathB: string,
): number {
  if (scoreA !== scoreB) return scoreB - scoreA
  if (pathA.length !== pathB.length) return pathA.length - pathB.length
  return pathA.localeCompare(pathB)
}

function normalizeWordQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isAsciiLetterOrDigit(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isWordSeparator(ch: string): boolean {
  return !isAsciiLetterOrDigit(ch)
}

function getWordStarts(text: string): number[] {
  const starts: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === undefined || isWordSeparator(ch)) continue
    const prev = i > 0 ? text[i - 1] : undefined
    if (prev === undefined || isWordSeparator(prev)) starts.push(i)
  }
  return starts
}

function findWordPrefix(text: string, piece: string, from: number): number {
  for (const start of getWordStarts(text)) {
    if (start < from) continue
    if (text.startsWith(piece, start)) return start
  }
  return -1
}

function wordPiecesMatch(text: string, pieces: readonly string[]): boolean {
  let from = 0
  for (const piece of pieces) {
    const start = findWordPrefix(text, piece, from)
    if (start === -1) return false
    from = start + piece.length
  }
  return true
}

function compactWordStartsMatch(text: string, query: string): boolean {
  const starts = getWordStarts(text)

  const visit = (startIndex: number, queryIndex: number): boolean => {
    if (queryIndex >= query.length) return true

    for (let i = startIndex; i < starts.length; i++) {
      const start = starts[i]!
      let consumed = 0
      while (queryIndex + consumed < query.length && start + consumed < text.length) {
        const queryChar = query[queryIndex + consumed]
        const textChar = text[start + consumed]
        if (queryChar === undefined || textChar === undefined || queryChar !== textChar) break
        consumed++
      }

      for (let count = consumed; count > 0; count--) {
        if (visit(i + 1, queryIndex + count)) return true
      }
    }

    return false
  }

  return visit(0, 0)
}

export function wordMatchField(text: string, query: string): boolean {
  const normalizedQuery = normalizeWordQuery(query)
  if (!normalizedQuery) return true

  const normalizedText = text.toLowerCase()
  if (normalizedText.includes(normalizedQuery)) return true

  const pieces = normalizedQuery.split(' ').filter((piece) => piece.length > 0)
  if (pieces.length > 1) return wordPiecesMatch(normalizedText, pieces)

  const firstPiece = pieces[0]
  return firstPiece !== undefined && compactWordStartsMatch(normalizedText, firstPiece)
}
