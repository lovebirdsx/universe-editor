/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The sync history's pure formatting. What matters here is the "unavailable vs
 *  zero" discipline the wire contract states — those two are one careless
 *  `?? 0` apart, and the difference is a lie about a run that moved bytes.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  P4SyncCountsDto,
  P4SyncRunDetailDto,
  P4SyncRunDto,
} from '@universe-editor/extensions-common'
import {
  countsLine,
  engineLabel,
  filesLabel,
  formatBytes,
  formatCounts,
  formatDiskWrites,
  formatDuration,
  formatTarget,
  outcomeLabel,
  scopeLines,
  triggerLabel,
} from '../syncHistoryFormat.js'

function run(overrides: Partial<P4SyncRunDto> = {}): P4SyncRunDto {
  return {
    id: '1',
    at: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    durationMs: 1200,
    clientRoot: 'X:/p4ws/main',
    spec: '#head',
    force: false,
    trigger: 'explorer',
    outcome: 'applied',
    scopeNarrowed: false,
    scopeFirst: [{ path: 'X:/p4ws/main/src', isDirectory: true }],
    scopeCount: 1,
    ...overrides,
  }
}

const NO_COUNTS: P4SyncCountsDto = {
  applied: 0,
  refusedModified: 0,
  refusedOverwrite: 0,
  keptOpen: 0,
  mustResolve: 0,
  handoff: 0,
}

describe('formatDuration', () => {
  it('keeps sub-second runs legible instead of rounding them to 0s', () => {
    expect(formatDuration(400)).toBe('400ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('shows tenths below ten seconds and whole units above', () => {
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(65_000)).toBe('1m 5s')
  })
})

describe('formatBytes', () => {
  it('scales by 1024, like the extension side it mirrors', () => {
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2KB')
    expect(formatBytes(3 * 1024 ** 2)).toBe('3MB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5GB')
  })
})

describe('formatTarget', () => {
  it('names the known forms and passes anything else through verbatim', () => {
    expect(formatTarget('#head')).toBe('the latest revision')
    // The prompt passes what the user typed through, so `#HEAD` is the same run.
    expect(formatTarget('#HEAD')).toBe('the latest revision')
    expect(formatTarget('@4521')).toBe('changelist 4521')
    // Identity, not truthiness: `''` is the per-file get, not "no target".
    expect(formatTarget('')).toBe('the selected files')
    expect(formatTarget('#4')).toBe('#4')
    expect(formatTarget('@2026/08/01')).toBe('@2026/08/01')
  })
})

describe('labels', () => {
  it('separates the δ-fallback run from one δ never served', () => {
    expect(engineLabel(run({ engine: 'p4delta' }))).toBe('p4delta (δ)')
    expect(engineLabel(run({ engine: 'p4', engineFallback: true }))).toBe('p4 (δ was tried)')
    expect(engineLabel(run({ engine: 'p4' }))).toBe('p4')
    // A run with no facts at all (the record has no engine) must not read as δ.
    expect(engineLabel(run())).toBe('p4')
  })

  it('gives every outcome and trigger its own name', () => {
    const outcomes = [
      'applied',
      'upToDate',
      'failed',
      'cancelled',
      'declined',
      'unrecognized',
    ] as const
    const labels = new Set(outcomes.map((o) => outcomeLabel(o)))
    expect(labels.size).toBe(outcomes.length)

    const triggers = ['statusBar', 'explorer', 'graph', 'timeline', 'command', 'recovery'] as const
    expect(new Set(triggers.map((t) => triggerLabel(t))).size).toBe(triggers.length)
  })
})

describe('formatCounts', () => {
  it('lists only the kinds that happened', () => {
    expect(formatCounts({ ...NO_COUNTS, applied: 3, refusedModified: 1 })).toBe(
      '3 updated · 1 with local changes',
    )
    expect(formatCounts({ ...NO_COUNTS, handoff: 12 })).toBe('12 handed to p4 as a batch')
  })

  it('says so when a run transferred nothing', () => {
    expect(formatCounts(NO_COUNTS)).toBe('nothing to transfer')
  })
})

describe('formatDiskWrites', () => {
  it('is always a lower bound', () => {
    // The count comes from the watcher, which truncates and honours exclude
    // globs: a bare "40" would claim a precision the number cannot have.
    expect(formatDiskWrites(40)).toBe('≥40 file events')
    expect(formatDiskWrites(0)).toBe('≥0 file events')
  })
})

describe('filesLabel', () => {
  it('does not claim a failed run never ran', () => {
    // A failed run carries an all-zero summary (p4 reported nothing before it
    // aborted), so the same shape must still read as "we do not know" — not as
    // "nothing to transfer", and certainly not as "never ran".
    expect(filesLabel(run({ outcome: 'failed', counts: NO_COUNTS }))).toBe('not reported by p4')
    expect(filesLabel(run({ outcome: 'cancelled', counts: NO_COUNTS }))).toBe('not reported by p4')
    // The only run that truly never executed is the declined one.
    expect(filesLabel(run({ outcome: 'declined' }))).toBe('this get never ran')
  })

  it('still reports the counts a refused run did manage', () => {
    // A run that applied some files and refused others knows both numbers.
    expect(
      filesLabel(run({ outcome: 'applied', counts: { ...NO_COUNTS, applied: 2, keptOpen: 1 } })),
    ).toBe('2 updated · 1 open for edit')
  })

  it('lets an up-to-date run say there was nothing to transfer', () => {
    expect(filesLabel(run({ outcome: 'upToDate', counts: NO_COUNTS }))).toBe('nothing to transfer')
    expect(countsLine(run({ outcome: 'upToDate', counts: NO_COUNTS }))).toBe('nothing to transfer')
  })
})

describe('scopeLines', () => {
  it('takes the paths from the detail scope and the omitted count from the DTO', () => {
    // `scopeOmitted` is the extension's own count of what its per-entry cap
    // dropped; re-deriving it as `scopeCount - scope.length` would be a second
    // spelling of one number, free to disagree with the first.
    const detail: P4SyncRunDetailDto = {
      ...run({ scopeCount: 100 }),
      scope: [
        { path: 'a', isDirectory: false },
        { path: 'b', isDirectory: true },
      ],
      scopeOmitted: 98,
    }
    expect(scopeLines(detail)).toEqual({ paths: ['a', 'b'], omitted: 98 })
  })

  it('shows a scope the extension reported in full as nothing omitted', () => {
    const detail: P4SyncRunDetailDto = {
      ...run(),
      scope: [{ path: 'a', isDirectory: false }],
      scopeOmitted: 0,
    }
    expect(scopeLines(detail)).toEqual({ paths: ['a'], omitted: 0 })
  })
})
