/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parse and guard the agent-produced `<runDir>/result.json`:
 *  `{ verdict: 'info' | 'escalate', summary, reportPath? }`.
 *  Docs: docs/development/triggers.md
 *--------------------------------------------------------------------------------------------*/

import type { TriggerVerdict, TriggerVerdictKind } from './types.js'

const VERDICT_KINDS: readonly TriggerVerdictKind[] = ['info', 'escalate']

const MAX_SUMMARY_LENGTH = 200

export type ParseVerdictResult =
  | { readonly ok: true; readonly verdict: TriggerVerdict }
  | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Relative, forward/backward slash agnostic, no drive letters, no `..` segment,
 * no `:` (drive / NTFS alternate data stream) and no segment Windows would
 * silently rewrite (trailing dots / spaces).
 */
export function isSafeRelativePath(path: string): boolean {
  const value = path.trim()
  if (value.length === 0) return false
  if (value.includes('://')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  if (value.includes(':')) return false
  return value.split(/[\\/]/).every((segment) => {
    const trimmed = segment.trim()
    if (trimmed !== segment) return false
    if (trimmed === '..') return false
    // A single `.` is a harmless current-directory marker; `foo.` is rewritten to
    // `foo` by Windows and can therefore address a different file than declared.
    return trimmed === '.' || !trimmed.endsWith('.')
  })
}

export function parseVerdict(raw: string): ParseVerdictResult {
  const text = raw.replace(/^﻿/, '').trim()
  if (text.length === 0) return { ok: false, error: 'result.json is empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `result.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'result.json must contain a JSON object' }

  const kind = parsed['verdict']
  if (typeof kind !== 'string' || !VERDICT_KINDS.includes(kind as TriggerVerdictKind)) {
    return { ok: false, error: `"verdict" must be one of ${VERDICT_KINDS.join(' | ')}` }
  }

  let summary = ''
  if (parsed['summary'] !== undefined) {
    if (typeof parsed['summary'] !== 'string') {
      return { ok: false, error: '"summary" must be a string' }
    }
    summary = parsed['summary'].slice(0, MAX_SUMMARY_LENGTH)
  }

  let reportPath: string | undefined
  if (parsed['reportPath'] !== undefined) {
    if (typeof parsed['reportPath'] !== 'string' || !isSafeRelativePath(parsed['reportPath'])) {
      return { ok: false, error: '"reportPath" must be a relative path without ".."' }
    }
    reportPath = parsed['reportPath'].trim()
  }

  return {
    ok: true,
    verdict: {
      verdict: kind as TriggerVerdictKind,
      summary,
      ...(reportPath === undefined ? {} : { reportPath }),
    },
  }
}
