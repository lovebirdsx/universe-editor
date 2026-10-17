/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The sync history's CSV export. What matters here: the columns are the raw
 *  DTO fields (not the localized prose the page renders), a missing measurement
 *  stays an EMPTY cell instead of becoming a zero, and the file is something a
 *  spreadsheet can open (BOM + CRLF).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { P4SyncRunDto } from '@universe-editor/extensions-common'
import { runsToCsv } from '../syncHistoryCsv.js'
import { UTF8_BOM } from '../../../services/editor/leadingBom.js'

const ROOT = 'X:/p4ws/main'

/** 2026-10-10T03:35:22Z / 03:32:29Z — fixed so the ISO cells are exact. */
const AT = Date.UTC(2026, 9, 10, 3, 35, 22)
const STARTED_AT = Date.UTC(2026, 9, 10, 3, 32, 29)

const HEADER =
  'id,at,startedAt,durationMs,outcome,spec,engine,engineFallback,force,deleteUntracked,' +
  'parallelThreads,' +
  'clientRoot,trigger,counts.applied,counts.refusedModified,counts.refusedOverwrite,' +
  'counts.keptOpen,counts.mustResolve,counts.handoff,counts.untrackedDeleted,' +
  'io.readBytes,io.writeBytes,diskWrites,' +
  'p4Calls.total,p4Calls.native,p4Calls.p4delta,p4Calls.complete,' +
  'p4Calls.p4deltaByCommand,p4Calls.p4deltaByCommandComplete,deltaRunId,' +
  'error.kind,error.message,scopeNarrowed,scopeCount,scopeFirst'

function makeRun(overrides: Partial<P4SyncRunDto> = {}): P4SyncRunDto {
  return {
    id: 'run-1',
    at: AT,
    startedAt: STARTED_AT,
    durationMs: 173000,
    clientRoot: ROOT,
    spec: '#head',
    force: false,
    trigger: 'graph',
    outcome: 'applied',
    engine: 'p4',
    engineFallback: false,
    parallelThreads: 4,
    counts: {
      applied: 3,
      refusedModified: 0,
      refusedOverwrite: 0,
      keptOpen: 0,
      mustResolve: 0,
      handoff: 0,
    },
    io: { readBytes: 4096, writeBytes: 1024 },
    diskWrites: 3,
    p4Calls: { native: 1, p4delta: 2, complete: true },
    scopeNarrowed: false,
    scopeFirst: [{ path: `${ROOT}/src`, isDirectory: true }],
    scopeCount: 1,
    ...overrides,
  }
}

/** The CSV split into logical lines, tolerating a quoted cell spanning line
 *  breaks (a naive `split` would see an embedded `\n` as a row boundary). The
 *  leading BOM belongs to the file, not to its first line. */
function logicalLines(csv: string): string[] {
  const text = csv.startsWith(UTF8_BOM) ? csv.slice(UTF8_BOM.length) : csv
  const lines: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      quoted = !quoted
      current += char
    } else if (char === '\r' && text[i + 1] === '\n' && !quoted) {
      lines.push(current)
      current = ''
      i++
    } else {
      current += char
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

describe('runsToCsv', () => {
  it('has the header line and one line per run', () => {
    const csv = runsToCsv([makeRun(), makeRun({ id: 'run-2' })])
    const lines = logicalLines(csv)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(HEADER)
  })

  it('writes the raw values of a run in column order', () => {
    const csv = runsToCsv([makeRun()])
    expect(logicalLines(csv)[1]).toBe(
      `${[
        'run-1',
        '2026-10-10T03:35:22.000Z',
        '2026-10-10T03:32:29.000Z',
        '173000',
        'applied',
        '#head',
        'p4',
        'false',
        'false',
        '',
        '4',
        ROOT,
        'graph',
        '3',
        '0',
        '0',
        '0',
        '0',
        '0',
        '',
        '4096',
        '1024',
        '3',
        '3',
        '1',
        '2',
        'true',
        '',
        '',
        '',
        '',
        '',
        'false',
        '1',
        `${ROOT}/src`,
      ].join(',')}`,
    )
  })

  it('writes the delete-untracked flag and its count as their own columns', () => {
    const run = makeRun({
      force: true,
      deleteUntracked: true,
      counts: {
        applied: 1,
        refusedModified: 0,
        refusedOverwrite: 0,
        keptOpen: 0,
        mustResolve: 0,
        handoff: 0,
        untrackedDeleted: 2,
      },
    })
    const cells = (logicalLines(runsToCsv([run]))[1] ?? '').split(',')
    expect(cells[8]).toBe('true') // force
    expect(cells[9]).toBe('true') // deleteUntracked
    expect(cells[19]).toBe('2') // counts.untrackedDeleted, apart from applied
  })

  it('leaves both io cells empty when no sampler ran — never 0', () => {
    // `exactOptionalPropertyTypes`: "no sampler" is an ABSENT key, so the record
    // is built by dropping it rather than by setting it to undefined.
    const { io: _sampler, ...unsampled } = makeRun()
    const line = logicalLines(runsToCsv([unsampled]))[1] ?? ''
    const cells = line.split(',')
    // Columns 21/22 (0-based 20/21) are io.readBytes/io.writeBytes.
    expect(cells[20]).toBe('')
    expect(cells[21]).toBe('')
  })

  it('leaves the columns a run never filled empty, not zero', () => {
    const {
      engine: _engine,
      engineFallback: _fallback,
      parallelThreads: _threads,
      counts: _counts,
      diskWrites: _diskWrites,
      p4Calls: _p4Calls,
      ...rest
    } = makeRun()
    const run: P4SyncRunDto = { ...rest, spec: '', outcome: 'declined' }
    const cells = (logicalLines(runsToCsv([run]))[1] ?? '').split(',')
    expect(cells[5]).toBe('') // spec: a per-file get passes none
    expect(cells[6]).toBe('') // engine
    expect(cells[7]).toBe('') // engineFallback
    expect(cells[9]).toBe('') // deleteUntracked: the record predates the field
    expect(cells[10]).toBe('') // parallelThreads
    expect(cells.slice(13, 20)).toEqual(['', '', '', '', '', '', '']) // the seven counts
    expect(cells[22]).toBe('') // diskWrites
    // A record written before the field existed: all four cells blank, never 0 —
    // and `complete` blank too, so the count is not claimed exact either. The
    // classification and the δ run reference are blank for the same reason.
    expect(cells.slice(23, 27)).toEqual(['', '', '', ''])
    expect(cells[27]).toBe('') // p4Calls.p4deltaByCommand
    expect(cells[28]).toBe('') // p4Calls.p4deltaByCommandComplete
    expect(cells[29]).toBe('') // deltaRunId
  })

  it('writes the p4-call total, its two sources and the completeness flag', () => {
    // An incomplete count still writes its total; the `complete` cell is what
    // keeps it from reading as exact.
    const run = makeRun({ p4Calls: { native: 2, p4delta: 5, complete: false } })
    const cells = (logicalLines(runsToCsv([run]))[1] ?? '').split(',')
    expect(cells.slice(23, 27)).toEqual(['7', '2', '5', 'false'])
  })

  it('writes the δ breakdown biggest-first and the run reference beside it', () => {
    const run = makeRun({
      deltaRunId: 'p4d-1700000000000-4242-1-abcd1234',
      p4Calls: {
        native: 0,
        p4delta: 1078,
        complete: true,
        p4deltaByCommand: { sync: 740, ignores: 332, fstat: 3, set: 3 },
        p4deltaByCommandComplete: true,
      },
    })
    const line = logicalLines(runsToCsv([run]))[1] ?? ''
    expect(line).toContain('sync=740; ignores=332; fstat=3; set=3')
    expect(line).toContain('p4d-1700000000000-4242-1-abcd1234')
  })

  it('marks the classification column as a lower bound independently of the total', () => {
    // 总数确数（complete: true）而分类只是下界：两列必须分开说，否则表格里会把下界读成确数。
    const exact = makeRun({
      p4Calls: {
        native: 0,
        p4delta: 3,
        complete: true,
        p4deltaByCommand: { sync: 3 },
        p4deltaByCommandComplete: true,
      },
    })
    const lower = makeRun({
      p4Calls: {
        native: 0,
        p4delta: 3,
        complete: true,
        p4deltaByCommand: { sync: 3 },
        p4deltaByCommandComplete: false,
      },
    })
    const cellsOf = (run: P4SyncRunDto): string[] =>
      (logicalLines(runsToCsv([run]))[1] ?? '').split(',')
    expect(cellsOf(exact)[26]).toBe('true') // p4Calls.complete
    expect(cellsOf(exact)[28]).toBe('true') // p4Calls.p4deltaByCommandComplete
    expect(cellsOf(lower)[26]).toBe('true')
    expect(cellsOf(lower)[28]).toBe('false')
  })

  it('quotes delimiters, quotes, line breaks and surrounding blanks', () => {
    const run = makeRun({
      clientRoot: 'X:/p4ws/a,b',
      error: { kind: 'clobber', message: 'say "hi"\nsecond line' },
      scopeFirst: [{ path: ' X:/p4ws/main/src ', isDirectory: true }],
    })
    const csv = runsToCsv([run])
    // clientRoot / scopeFirst cells are quoted and the quote inside the message doubles.
    expect(csv).toContain('"X:/p4ws/a,b"')
    expect(csv).toContain('"say ""hi""\nsecond line"')
    expect(csv).toContain('" X:/p4ws/main/src "')
    // The embedded newline does not become a row of its own.
    expect(logicalLines(csv)).toHaveLength(2)
  })

  it('starts with a UTF-8 BOM and terminates lines with CRLF only', () => {
    const csv = runsToCsv([makeRun()])
    expect(csv.startsWith(UTF8_BOM)).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    // No bare LF: every \n is preceded by \r (values here contain none).
    expect(/[^\r]\n/.test(csv.replace(UTF8_BOM, ''))).toBe(false)
  })

  it('is just the header line for an empty history', () => {
    const csv = runsToCsv([])
    expect(csv).toBe(`${UTF8_BOM}${HEADER}\r\n`)
  })

  it('joins the visible scope paths into one cell', () => {
    const run = makeRun({
      scopeFirst: [
        { path: `${ROOT}/src`, isDirectory: true },
        { path: `${ROOT}/build.gradle`, isDirectory: false },
      ],
      scopeCount: 5,
    })
    const line = logicalLines(runsToCsv([run]))[1] ?? ''
    expect(line.endsWith(`,5,${ROOT}/src; ${ROOT}/build.gradle`)).toBe(true)
  })
})
