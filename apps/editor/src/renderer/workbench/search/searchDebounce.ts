/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  searchDebounce — how long to wait after a keystroke before running a search.
 *
 *  A regex like `.` or `\w` matches nearly every character in the workspace, so
 *  searching it on every keystroke floods the result pipeline while the user is
 *  still typing. Ported from VSCode's searchWidget.onSearchInputChanged: run the
 *  pattern against a fixed keyboard-ish sample and scale the debounce by how
 *  indiscriminately it matches.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keyboard-ish sample lifted from VSCode's searchWidget. The printable rows are
 * identical; the leading indentation is this file's, so `\s` counts differ and a
 * whitespace-only regex buckets lower here than upstream. The buckets that
 * matter — `.` and `\w`-style catch-alls — are unaffected.
 */
const MATCHINESS_SAMPLE = `
			~!@#$%^&*()_+
			\`1234567890-=
			qwertyuiop[]\\
			QWERTYUIOP{}|
			asdfghjkl;'
			ASDFGHJKL:"
			zxcvbnm,./
			ZXCVBNM<>? `

/**
 * Debounce multiplier for a regex pattern: 1 for a selective expression, 5 for
 * catch-alls like `.` or `\w`, 10 for one that also matches the empty string.
 * Returns 1 for an invalid regex — the search itself reports the syntax error.
 */
export function regexDelayMultiplier(pattern: string): number {
  let matchiness: number
  try {
    matchiness = MATCHINESS_SAMPLE.match(new RegExp(pattern, 'ug'))?.length ?? 0
  } catch {
    return 1
  }
  if (matchiness < 50) return 1
  if (matchiness < 100) return 5
  return 10
}

/** Debounce for one keystroke: the configured base, amplified for loose regexes. */
export function searchDebounceDelay(pattern: string, isRegex: boolean, baseMs: number): number {
  return isRegex ? baseMs * regexDelayMultiplier(pattern) : baseMs
}
