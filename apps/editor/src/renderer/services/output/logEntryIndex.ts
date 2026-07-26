/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure log-entry indexing + filtering for the Output panel's level/text
 *  filters. A log entry is a header line (carrying a level marker) plus the
 *  continuation lines that follow it (stack traces, pretty-printed JSON);
 *  lines before the first header form a level-less entry that level filters
 *  always keep visible. All functions are Monaco-free so they can run in
 *  node unit tests.
 *--------------------------------------------------------------------------------------------*/

import { LogLevel } from '@universe-editor/platform'

/** Level patterns mirroring the monarch token rules in monacoLogLanguage.ts. */
const LEVEL_PATTERNS: Array<[LogLevel, RegExp[]]> = [
  [
    LogLevel.Error,
    [
      /\[(error|err|critical|fatal|alert|failure)\]/i,
      /\b(ALERT|CRITICAL|EMERGENCY|ERROR|FAILURE|FAIL|Fatal|FATAL|Error|EE)\b/,
      /\berror\b(?=\s*:)/i,
    ],
  ],
  [
    LogLevel.Warning,
    [/\[(warn(?:ing)?|ww)\]/i, /\b(WARNING|WARN|Warn|WW)\b/, /\bwarning\b(?=\s*:)/i],
  ],
  [
    LogLevel.Info,
    [
      /\[(info(?:rmation)?|notice|ii)\]/i,
      /\b(HINT|INFO|INFORMATION|Info|NOTICE|II)\b/,
      /\b(info|information)\b(?=\s*:)/i,
    ],
  ],
  [LogLevel.Debug, [/\[(debug|dbug|dbg|de|d)\]/i, /\b(DEBUG|Debug)\b/, /\bdebug\b(?=\s*:)/i]],
  [
    LogLevel.Trace,
    [
      /\[(trace|verbose|verb|vrb|vb|v)\]/i,
      /\b([Tt]race|TRACE)\b/,
      /\b(verbose|verb|vrb|vb|v)\b(?=\s*:)/i,
    ],
  ],
]

/** First level marker wins; higher-severity levels are tried first. */
export function matchLogLevel(line: string): LogLevel | undefined {
  for (const [level, patterns] of LEVEL_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(line)) return level
    }
  }
  return undefined
}

/** Half-open line range [startLine, endLineExclusive), 1-based. */
export interface LogEntryRange {
  readonly startLine: number
  readonly endLineExclusive: number
}

export interface LogEntry extends LogEntryRange {
  /** undefined for the preamble entry before the first header line. */
  readonly level: LogLevel | undefined
}

export function buildLogEntries(lines: readonly string[]): LogEntry[] {
  const entries: LogEntry[] = []
  let current: { startLine: number; level: LogLevel | undefined } | undefined
  lines.forEach((line, index) => {
    const level = matchLogLevel(line)
    if (level !== undefined) {
      if (current) {
        entries.push({
          startLine: current.startLine,
          endLineExclusive: index + 1,
          level: current.level,
        })
      }
      current = { startLine: index + 1, level }
    } else if (!current) {
      current = { startLine: index + 1, level: undefined }
    }
  })
  if (current) {
    entries.push({
      startLine: current.startLine,
      endLineExclusive: lines.length + 1,
      level: current.level,
    })
  }
  return entries
}

export interface LogFilterTerms {
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
}

/**
 * VSCode-style output filter syntax: comma-separated terms; `!` prefix negates;
 * double quotes wrap a term containing commas (`foo, !bar, "a,b"`). Matching is
 * case-insensitive substring.
 */
export function parseLogFilterText(text: string): LogFilterTerms {
  const includes: string[] = []
  const excludes: string[] = []
  const push = (raw: string) => {
    const term = raw.trim()
    if (!term) return
    if (term.startsWith('!')) {
      const negated = term.slice(1).trim()
      if (negated) excludes.push(negated.toLowerCase())
    } else {
      includes.push(term.toLowerCase())
    }
  }
  // Split on commas, but keep commas inside a double-quoted segment.
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === ',' && !quoted) {
      push(current)
      current = ''
      continue
    }
    current += ch
  }
  push(current)
  return { includes, excludes }
}

function entryMatchesTerms(text: string, terms: LogFilterTerms): boolean {
  const lower = text.toLowerCase()
  if (terms.excludes.some((term) => lower.includes(term))) return false
  if (terms.includes.length === 0) return true
  return terms.includes.some((term) => lower.includes(term))
}

/**
 * Compute the line ranges hidden by the given level + text filters. A range is
 * hidden when its entry's level is off, or when it survives level filtering but
 * no line inside it matches the text terms. Merges adjacent hidden entries.
 */
export function computeHiddenRanges(
  lines: readonly string[],
  hiddenLevels: ReadonlySet<LogLevel>,
  filterText: string,
): LogEntryRange[] {
  if (hiddenLevels.size === 0 && filterText.trim() === '') return []
  const terms = parseLogFilterText(filterText)
  const entries = buildLogEntries(lines)
  const hidden: LogEntryRange[] = []
  for (const entry of entries) {
    if (entry.level !== undefined && hiddenLevels.has(entry.level)) {
      hidden.push({ startLine: entry.startLine, endLineExclusive: entry.endLineExclusive })
      continue
    }
    if (terms.includes.length === 0 && terms.excludes.length === 0) continue
    const anyMatch = lines
      .slice(entry.startLine - 1, entry.endLineExclusive - 1)
      .some((line) => entryMatchesTerms(line, terms))
    if (!anyMatch)
      hidden.push({ startLine: entry.startLine, endLineExclusive: entry.endLineExclusive })
  }
  const merged: LogEntryRange[] = []
  for (const range of hidden) {
    const last = merged[merged.length - 1]
    if (last && last.endLineExclusive >= range.startLine) {
      merged[merged.length - 1] = {
        startLine: last.startLine,
        endLineExclusive: range.endLineExclusive,
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}
