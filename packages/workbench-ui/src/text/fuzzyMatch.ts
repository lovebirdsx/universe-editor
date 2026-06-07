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

/**
 * Relevance score for matching `query` against a single field. Higher is more
 * relevant; -1 means no match. Tiers: prefix beats substring beats loose
 * subsequence, and within a tier a shorter field ranks higher. Mirrors the
 * tiering the @-mention file search uses so every "type to filter" surface
 * orders results consistently — callers combine per-field scores as they see
 * fit (e.g. weighting a name above a description).
 */
export function scoreFuzzyMatch(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (t.startsWith(q)) return 1000 - t.length
  if (t.includes(q)) return 500 - t.length
  if (fuzzyMatchField(t, q)) return 50 - t.length
  return -1
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
