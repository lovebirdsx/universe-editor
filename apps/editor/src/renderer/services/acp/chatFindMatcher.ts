/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  chatFindMatcher — plain-substring matching for the in-session find feature.
 *  Pure (no DOM / Range / CSS), so it is unit-testable and reusable per text
 *  node when collecting highlight ranges. Matches are case-insensitive and
 *  non-overlapping, left to right.
 *--------------------------------------------------------------------------------------------*/

export interface FindRange {
  readonly start: number
  readonly end: number
}

/**
 * Non-overlapping, case-insensitive substring matches of `query` within
 * `haystack`. Returns `[]` for an empty query. Called per text node so the
 * `toLowerCase()` length quirk (ß / İ widen) stays local and never shifts
 * indices across nodes.
 */
export function computeMatches(haystack: string, query: string): readonly FindRange[] {
  if (query.length === 0) return []
  const h = haystack.toLowerCase()
  const q = query.toLowerCase()
  const out: FindRange[] = []
  let from = 0
  for (;;) {
    const i = h.indexOf(q, from)
    if (i < 0) break
    out.push({ start: i, end: i + q.length })
    from = i + q.length
  }
  return out
}
