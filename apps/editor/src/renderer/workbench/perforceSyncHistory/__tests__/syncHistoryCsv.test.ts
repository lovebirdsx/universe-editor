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
  'id,at,startedAt,durationMs,outcome,spec,engine,engineFallback,force,parallelThreads,' +
  'clientRoot,trigger,counts.applied,counts.refusedModified,counts.refusedOverwrite,' +
  'counts.keptOpen,counts.mustResolve,counts.handoff,io.readBytes,io.writeBytes,diskWrites,' +
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
        '4',
        ROOT,
        'graph',
        '3',
        '0',
        '0',
        '0',
        '0',
        '0',
        '4096',
        '1024',
        '3',
        '',
        '',
        'false',
        '1',
        `${ROOT}/src`,
      ].join(',')}`,
    )
  })

  it('leaves both io cells empty when no sampler ran — never 0', () => {
    // `exactOptionalPropertyTypes`: "no sampler" is an ABSENT key, so the record
    // is built by dropping it rather than by setting it to undefined.
    const { io: _sampler, ...unsampled } = makeRun()
    const line = logicalLines(runsToCsv([unsampled]))[1] ?? ''
    const cells = line.split(',')
    // Columns 19/20 (0-based 18/19) are io.readBytes/io.writeBytes.
    expect(cells[18]).toBe('')
    expect(cells[19]).toBe('')
  })

  it('leaves the columns a run never filled empty, not zero', () => {
    const {
      engine: _engine,
      engineFallback: _fallback,
      parallelThreads: _threads,
      counts: _counts,
      diskWrites: _diskWrites,
      ...rest
    } = makeRun()
    const run: P4SyncRunDto = { ...rest, spec: '', outcome: 'declined' }
    const cells = (logicalLines(runsToCsv([run]))[1] ?? '').split(',')
    expect(cells[5]).toBe('') // spec: a per-file get passes none
    expect(cells[6]).toBe('') // engine
    expect(cells[7]).toBe('') // engineFallback
    expect(cells[9]).toBe('') // parallelThreads
    expect(cells.slice(12, 18)).toEqual(['', '', '', '', '', '']) // the six counts
    expect(cells[20]).toBe('') // diskWrites
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
