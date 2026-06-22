/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parser for Next Edit Suggestion replies. The NES model is asked to return a
 *  set of whole-line replacements:
 *    { "edits": [ { "startLine": 12, "endLine": 14, "newText": "..." }, … ] }
 *  (1-based, inclusive) or `{ "noEdit": true }` when nothing should change. A bare
 *  array or a single edit object are also accepted for robustness. This turns the
 *  reply into validated, non-overlapping edits sorted top-to-bottom, returning null
 *  on any malformed / out-of-range / overlapping output so the caller simply offers
 *  no suggestion.
 *
 *  Multiple edits are merged by composeNesEdits into one contiguous span (a single
 *  range + rebuilt full text, unchanged lines kept verbatim) so Monaco's inline
 *  edit can diff it into several highlights and accept them all with one Tab —
 *  e.g. renaming every occurrence of a variable at once.
 *
 *  Pure + side-effect free for unit testing, mirroring sanitizeCompletion.
 *--------------------------------------------------------------------------------------------*/

export interface ParsedNesEdit {
  startLine: number
  endLine: number
  newText: string
}

/**
 * Parse a model reply into validated, non-overlapping whole-line replacements
 * sorted top-to-bottom, or null when the reply is unusable (not JSON, signals no
 * edit, empty, addresses lines outside `lineCount`, or contains overlapping
 * ranges). Line numbers are 1-based and inclusive.
 */
export function parseNesEdits(raw: string, lineCount: number): ParsedNesEdit[] | null {
  const json = extractFirstJsonValue(stripCodeFence(raw))
  if (json === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const rawEdits = toRawEditList(parsed)
  if (rawEdits === null || rawEdits.length === 0) return null

  const edits: ParsedNesEdit[] = []
  for (const candidate of rawEdits) {
    const edit = validateEdit(candidate, lineCount)
    if (edit === null) return null
    edits.push(edit)
  }

  edits.sort((a, b) => a.startLine - b.startLine)
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.startLine <= edits[i - 1]!.endLine) return null // overlap → no suggestion
  }
  return edits
}

/**
 * Merge non-overlapping, sorted edits into a single contiguous replacement
 * spanning from the first edit's startLine to the last edit's endLine. Lines
 * between edits are kept verbatim via `getLineContent` so Monaco's internal diff
 * sees only the genuine changes. `edits` must be sorted and non-overlapping (as
 * returned by parseNesEdits) and non-empty.
 */
export function composeNesEdits(
  edits: readonly ParsedNesEdit[],
  getLineContent: (line: number) => string,
): ParsedNesEdit {
  const spanStart = edits[0]!.startLine
  const spanEnd = edits[edits.length - 1]!.endLine

  const parts: string[] = []
  let cursor = spanStart
  for (const edit of edits) {
    for (let line = cursor; line < edit.startLine; line++) parts.push(getLineContent(line))
    parts.push(edit.newText)
    cursor = edit.endLine + 1
  }
  for (let line = cursor; line <= spanEnd; line++) parts.push(getLineContent(line))

  return { startLine: spanStart, endLine: spanEnd, newText: parts.join('\n') }
}

/** Normalize the parsed JSON into a list of raw edit candidates, or null. */
function toRawEditList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj['noEdit'] === true) return null
  if (Array.isArray(obj['edits'])) return obj['edits']
  // Tolerate a single edit object at the top level.
  if ('startLine' in obj || 'endLine' in obj || 'newText' in obj) return [obj]
  return null
}

/** Validate one raw edit candidate, returning null when it is malformed. */
function validateEdit(candidate: unknown, lineCount: number): ParsedNesEdit | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const { startLine, endLine, newText } = candidate as Record<string, unknown>
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || typeof newText !== 'string') {
    return null
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null
  if (startLine < 1 || endLine < startLine || endLine > lineCount) return null
  return { startLine, endLine, newText }
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return raw
  const lines = trimmed.split('\n')
  lines.shift() // opening ``` (optionally with a language tag)
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === '```') lines.pop()
  return lines.join('\n')
}

/**
 * Slice out the first balanced `{...}` object or `[...]` array, ignoring braces /
 * brackets inside strings so a `newText` containing them doesn't truncate early.
 * Returns null when no balanced value is present.
 */
function extractFirstJsonValue(text: string): string | null {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  let start: number
  if (objStart === -1) start = arrStart
  else if (arrStart === -1) start = objStart
  else start = Math.min(objStart, arrStart)
  if (start === -1) return null

  const opener = text[start]!
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
