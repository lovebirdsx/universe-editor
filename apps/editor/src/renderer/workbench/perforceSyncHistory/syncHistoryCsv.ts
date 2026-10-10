/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CSV rendering for the Perforce sync-history export.
 *
 *  The file is data, not UI: headers are the DTO's own field names and values
 *  are the raw ones, so a column means the same thing in every install and in
 *  any script that reads the file. That is also why the "missing" semantics of
 *  the wire contract survive verbatim — an absent `io` is an EMPTY cell, not 0
 *  (no sampler is not "moved no bytes"), and an absent `diskWrites` is empty
 *  rather than a bound nobody observed.
 *
 *  Values are written as-is, including ones starting with `=` or `@` (`@4521`
 *  is a legitimate target): neutralizing spreadsheet formulas would corrupt the
 *  recorded data to defend against a file the user exported from their own
 *  machine.
 *--------------------------------------------------------------------------------------------*/

import type { P4SyncCountsDto, P4SyncRunDto } from '@universe-editor/extensions-common'
import { UTF8_BOM } from '../../services/editor/leadingBom.js'

const CRLF = '\r\n'

/** Header cells, in row order. */
const COLUMNS = [
  'id',
  'at',
  'startedAt',
  'durationMs',
  'outcome',
  'spec',
  'engine',
  'engineFallback',
  'force',
  'parallelThreads',
  'clientRoot',
  'trigger',
  'counts.applied',
  'counts.refusedModified',
  'counts.refusedOverwrite',
  'counts.keptOpen',
  'counts.mustResolve',
  'counts.handoff',
  'io.readBytes',
  'io.writeBytes',
  'diskWrites',
  'error.kind',
  'error.message',
  'scopeNarrowed',
  'scopeCount',
  'scopeFirst',
] as const

export function runsToCsv(runs: readonly P4SyncRunDto[]): string {
  const lines = [COLUMNS.join(',')]
  for (const run of runs) lines.push(rowOf(run))
  // A trailing newline: text tools and `git diff` treat a missing final newline
  // as a mangled file. The BOM is what makes Excel read UTF-8 (Chinese error
  // messages included) instead of the local codepage.
  return UTF8_BOM + lines.join(CRLF) + CRLF
}

function rowOf(run: P4SyncRunDto): string {
  return [
    run.id,
    toIso(run.at),
    toIso(run.startedAt),
    String(run.durationMs),
    run.outcome,
    run.spec,
    run.engine ?? '',
    bool(run.engineFallback),
    bool(run.force),
    optional(run.parallelThreads),
    run.clientRoot,
    run.trigger,
    count(run, 'applied'),
    count(run, 'refusedModified'),
    count(run, 'refusedOverwrite'),
    count(run, 'keptOpen'),
    count(run, 'mustResolve'),
    count(run, 'handoff'),
    optional(run.io?.readBytes),
    optional(run.io?.writeBytes),
    optional(run.diskWrites),
    run.error?.kind ?? '',
    run.error?.message ?? '',
    bool(run.scopeNarrowed),
    String(run.scopeCount),
    run.scopeFirst.map((entry) => entry.path).join('; '),
  ]
    .map(csvCell)
    .join(',')
}

function count(run: P4SyncRunDto, key: keyof P4SyncCountsDto): string {
  return optional(run.counts?.[key])
}

function optional(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function bool(value: boolean | undefined): string {
  return value === undefined ? '' : value ? 'true' : 'false'
}

function toIso(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** RFC 4180 quoting: delimiters, quotes, line breaks and surrounding blanks
 *  force quotes; a literal quote doubles. */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value) && value === value.trim()) return value
  return `"${value.replace(/"/g, '""')}"`
}
