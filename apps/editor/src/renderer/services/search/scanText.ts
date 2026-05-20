/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-file text scanning helpers used by TextSearchService.
 *--------------------------------------------------------------------------------------------*/

import type {
  ITextSearchMatch,
  ITextSearchQuery,
  ITextSearchRange,
} from '@universe-editor/platform'

/** Cap on the raw line preview length so the UI doesn't choke on minified files. */
export const PREVIEW_MAX_LENGTH = 500

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a global RegExp from the user query. Throws if the regex is invalid
 * (callers can surface that as an "invalid regex" inline error).
 */
export function compileQuery(
  query: Pick<ITextSearchQuery, 'pattern' | 'isRegex' | 'matchCase' | 'matchWholeWord'>,
): RegExp {
  let source = query.isRegex ? query.pattern : escapeForRegex(query.pattern)
  if (query.matchWholeWord) source = `\\b(?:${source})\\b`
  const flags = query.matchCase ? 'g' : 'gi'
  return new RegExp(source, flags)
}

/** Heuristic: a file whose first ~8KB contains a NUL byte is treated as binary. */
export function isBinary(text: string): boolean {
  const sample = text.length > 8192 ? text.slice(0, 8192) : text
  return sample.indexOf('\0') !== -1
}

/**
 * Scan a file's full text for the given regex. Returns matches grouped by
 * line. Caller controls how many matches to keep with `capPerFile`. Once the
 * cap is hit, scanning stops and the partial result is returned (the caller
 * can flag the file as truncated).
 */
export function scanText(
  text: string,
  re: RegExp,
  capPerFile: number,
): { matches: ITextSearchMatch[]; truncated: boolean } {
  if (capPerFile <= 0) return { matches: [], truncated: false }
  const lines = text.split(/\r?\n/)
  const out: ITextSearchMatch[] = []
  let count = 0
  let truncated = false

  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    re.lastIndex = 0
    let ranges: ITextSearchRange[] | null = null
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const start = m.index
      const end = start + m[0].length
      // Avoid infinite loop on zero-length matches.
      if (m[0].length === 0) {
        re.lastIndex = start + 1
        continue
      }
      ranges ??= []
      // Columns are 1-based; endColumn is exclusive (1 past last char).
      ranges.push({ startColumn: start + 1, endColumn: end + 1 })
      count++
      if (count >= capPerFile) {
        truncated = true
        if (ranges.length > 0) {
          out.push({
            lineNumber: i + 1,
            preview: line.length > PREVIEW_MAX_LENGTH ? line.slice(0, PREVIEW_MAX_LENGTH) : line,
            ranges,
          })
        }
        break outer
      }
    }
    if (ranges && ranges.length > 0) {
      out.push({
        lineNumber: i + 1,
        preview: line.length > PREVIEW_MAX_LENGTH ? line.slice(0, PREVIEW_MAX_LENGTH) : line,
        ranges,
      })
    }
  }

  return { matches: out, truncated }
}
