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
  'deleteUntracked',
  'parallelThreads',
  'clientRoot',
  'trigger',
  'counts.applied',
  'counts.trackedDeleted',
  'counts.refusedModified',
  'counts.refusedOverwrite',
  'counts.keptOpen',
  'counts.mustResolve',
  'counts.handoff',
  'counts.untrackedDeleted',
  'io.readBytes',
  'io.writeBytes',
  'diskWrites',
  'p4Calls.total',
  'p4Calls.native',
  'p4Calls.p4delta',
  'p4Calls.complete',
  // The δ side's own breakdown, as `command=count; …` (biggest first) exactly
  // like the detail pane shows it. Empty = not collected, which is not "no
  // calls". The column right after it says whether this breakdown is a complete
  // tally or only a LOWER BOUND — independent of `p4Calls.complete`, which is
  // about the total: a record can have an exact total yet a lower-bound split.
  'p4Calls.p4deltaByCommand',
  'p4Calls.p4deltaByCommandComplete',
  // The run reference, so a row in the spreadsheet can be matched against the
  // p4delta log file of the same name. Empty = δ never ran for this get.
  'deltaRunId',
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
    bool(run.deleteUntracked),
    optional(run.parallelThreads),
    run.clientRoot,
    run.trigger,
    count(run, 'applied'),
    count(run, 'trackedDeleted'),
    count(run, 'refusedModified'),
    count(run, 'refusedOverwrite'),
    count(run, 'keptOpen'),
    count(run, 'mustResolve'),
    count(run, 'handoff'),
    count(run, 'untrackedDeleted'),
    optional(run.io?.readBytes),
    optional(run.io?.writeBytes),
    optional(run.diskWrites),
    // The total is written even when `complete` is false — the completeness
    // column is what keeps a lower bound from reading as an exact number.
    optional(run.p4Calls !== undefined ? run.p4Calls.native + run.p4Calls.p4delta : undefined),
    optional(run.p4Calls?.native),
    optional(run.p4Calls?.p4delta),
    bool(run.p4Calls?.complete),
    byCommand(run),
    bool(run.p4Calls?.p4deltaByCommandComplete),
    run.deltaRunId ?? '',
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

/** δ 侧的分类账，`command=count; …`，按次数降序（同数按命令名）。用 `=`/`;` 而不是显示层的
 *  `·`：单元格是数据，能被脚本稳定地切开。空串 = 未采集。 */
function byCommand(run: P4SyncRunDto): string {
  const tally = run.p4Calls?.p4deltaByCommand
  if (tally === undefined) return ''
  return Object.entries(tally)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([command, n]) => `${command}=${n}`)
    .join('; ')
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
