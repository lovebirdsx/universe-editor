import { describe, expect, it } from 'vitest'
import type { SyncRunSummary } from '../syncParser.js'
import {
  buildSyncHistoryEntry,
  isEntry,
  nextSyncHistoryId,
  outcomeOfRun,
  toRunDetailDto,
  toRunDto,
  type BuildSyncHistoryInput,
  type SyncHistoryEntry,
  type SyncRunFacts,
  type SyncRunHistoryInput,
} from '../syncHistory.js'
import type { SyncScopeTarget } from '../p4Filespec.js'

const ROOT = 'X:/p4ws/main'
const SRC: SyncScopeTarget = { path: `${ROOT}/src`, isDirectory: true }

function summary(extra: Partial<SyncRunSummary> = {}): SyncRunSummary {
  return {
    applied: 0,
    keptOpen: 0,
    mustResolve: 0,
    refusedModified: 0,
    refusedOverwrite: 0,
    handoff: 0,
    upToDate: false,
    unrecognized: false,
    ...extra,
  }
}

function run(extra: Partial<SyncRunHistoryInput> = {}): SyncRunHistoryInput {
  return { ok: true, cancelled: false, summary: summary(), error: undefined, ...extra }
}

function facts(extra: Partial<SyncRunFacts> = {}): SyncRunFacts {
  return {
    engine: 'p4',
    engineFallback: false,
    parallelThreads: 4,
    startedAt: 1000,
    endedAt: 2000,
    diskWrites: 7,
    ...extra,
  }
}

function build(extra: Partial<BuildSyncHistoryInput> = {}): SyncHistoryEntry {
  return buildSyncHistoryEntry({
    id: 'id-1',
    at: 3000,
    clientRoot: ROOT,
    spec: '#head',
    force: false,
    trigger: 'explorer',
    scope: [SRC],
    scopeNarrowed: false,
    outcome: 'applied',
    run: run(),
    ...extra,
  })
}

describe('outcomeOfRun', () => {
  it('reports declined when the get never ran', () => {
    expect(outcomeOfRun(undefined)).toBe('declined')
  })

  it('reports declined — not failed — for the editor’s own refusal', () => {
    // `ok: false` also describes a p4 run that failed; `notRun` is what tells
    // the two apart, and the refusal outranks it.
    expect(outcomeOfRun(run({ ok: false, notRun: true }))).toBe('declined')
  })

  it('reports cancelled for a user cancellation, not a failure', () => {
    expect(outcomeOfRun(run({ ok: false, cancelled: true }))).toBe('cancelled')
  })

  it('reports failed for a nonzero exit even with a summary present', () => {
    const s = summary({ applied: 3 })
    expect(outcomeOfRun(run({ ok: false, summary: s }))).toBe('failed')
  })

  it('reports upToDate only when p4 said so and nothing else happened', () => {
    expect(outcomeOfRun(run({ summary: summary({ upToDate: true }) }))).toBe('upToDate')
  })

  it('reports applied when files landed despite an up-to-date line elsewhere', () => {
    const s = summary({ applied: 2, upToDate: true })
    expect(outcomeOfRun(run({ summary: s }))).toBe('applied')
  })

  it('reports unrecognized for an exit-0 run that did nothing legibly', () => {
    expect(outcomeOfRun(run({ summary: undefined }))).toBe('unrecognized')
    expect(outcomeOfRun(run({ summary: summary({ unrecognized: true }) }))).toBe('unrecognized')
  })

  it('reports applied when any of the six counts is nonzero', () => {
    expect(outcomeOfRun(run({ summary: summary({ refusedModified: 1 }) }))).toBe('applied')
    expect(outcomeOfRun(run({ summary: summary({ handoff: 1 }) }))).toBe('applied')
  })
})

describe('buildSyncHistoryEntry', () => {
  it('uses the client facts start stamp and computes the duration from it', () => {
    const entry = build({ at: 3000, run: run({ facts: facts({ startedAt: 1200 }) }) })
    expect(entry.startedAt).toBe(1200)
    expect(entry.durationMs).toBe(1800)
  })

  it('gives a get that never ran no clock and no facts at all', () => {
    // The gate was declined: `at` is the only instant there is, and the record
    // must not imply any of the run-shaped fields it never observed.
    const entry = build({ at: 3000, run: undefined, outcome: 'declined' })
    expect(entry.startedAt).toBe(3000)
    expect(entry.durationMs).toBe(0)
    expect(entry.engine).toBeUndefined()
    expect(entry.io).toBeUndefined()
    expect(entry.diskWrites).toBeUndefined()
    expect(entry.counts).toBeUndefined()
  })

  it('times a refused get at zero rather than measuring the refusal dialog', () => {
    // The client refused the range itself (`notRun`): it spawned nothing, then
    // sat on its own error toast. A run-shaped result must not smuggle that
    // reading time into the duration.
    const refused = run({
      ok: false,
      notRun: true,
      error: { kind: 'other', suggestion: 'the daily scope is not usable (blocked)' },
    })
    expect(outcomeOfRun(refused)).toBe('declined')
    const entry = build({ at: 3000, outcome: 'declined', run: refused })
    expect(entry.startedAt).toBe(3000)
    expect(entry.durationMs).toBe(0)
    expect(entry.engine).toBeUndefined()
    // The reason survives even though the run has no facts: "Not run" alone
    // leaves the user with nowhere to read why.
    expect(entry.error).toEqual({
      kind: 'other',
      message: 'the daily scope is not usable (blocked)',
    })
  })

  it('never records a negative duration', () => {
    const entry = build({ at: 3000, run: run({ facts: facts({ startedAt: 5000 }) }) })
    expect(entry.durationMs).toBe(0)
  })

  it('copies the six counts and the error suggestion', () => {
    const entry = build({
      outcome: 'failed',
      run: run({
        ok: false,
        summary: summary({
          applied: 1,
          refusedModified: 2,
          refusedOverwrite: 3,
          keptOpen: 4,
          mustResolve: 5,
          handoff: 6,
        }),
        error: { kind: 'clobber', suggestion: 'collect first' },
      }),
    })
    expect(entry.counts).toEqual({
      applied: 1,
      refusedModified: 2,
      refusedOverwrite: 3,
      keptOpen: 4,
      mustResolve: 5,
      handoff: 6,
    })
    expect(entry.error).toEqual({ kind: 'clobber', message: 'collect first' })
  })

  it('omits io when the run had no sampler, keeping the other facts', () => {
    const entry = build({ run: run({ facts: facts() }) })
    expect(entry.io).toBeUndefined()
    expect(entry.engine).toBe('p4')
    expect(entry.parallelThreads).toBe(4)
    expect(entry.diskWrites).toBe(7)
  })

  it('carries the io sample and the engine fallback flag', () => {
    const entry = build({
      run: run({
        facts: facts({
          engine: 'p4delta',
          engineFallback: true,
          io: { readBytes: 4096, writeBytes: 512 },
        }),
      }),
    })
    expect(entry.engine).toBe('p4delta')
    expect(entry.engineFallback).toBe(true)
    expect(entry.io).toEqual({ readBytes: 4096, writeBytes: 512 })
  })

  it('truncates an oversized scope and keeps the omitted count', () => {
    const scope: SyncScopeTarget[] = Array.from({ length: 100 }, (_, i) => ({
      path: `${ROOT}/f${i}.txt`,
      isDirectory: false,
    }))
    const entry = build({ scope })
    expect(entry.scope).toHaveLength(64)
    expect(entry.scopeOmitted).toBe(36)
  })
})

describe('nextSyncHistoryId', () => {
  it('is unique within a millisecond and carries the stamp', () => {
    const a = nextSyncHistoryId(1000)
    const b = nextSyncHistoryId(1000)
    expect(a).not.toBe(b)
    expect(a.startsWith('1000-')).toBe(true)
  })
})

describe('isEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isEntry(build())).toBe(true)
  })

  it('rejects entries with a missing identity or a bad outcome', () => {
    const entry = build()
    expect(isEntry({ ...entry, id: '' })).toBe(false)
    expect(isEntry({ ...entry, outcome: 'nope' })).toBe(false)
    expect(isEntry({ ...entry, trigger: 'nope' })).toBe(false)
    expect(isEntry({ ...entry, at: -1 })).toBe(false)
    expect(isEntry({ ...entry, durationMs: 1.5 })).toBe(false)
    expect(isEntry({ ...entry, clientRoot: '' })).toBe(false)
  })

  it('rejects scope entries that are not host paths', () => {
    const entry = build()
    expect(isEntry({ ...entry, scope: [{ path: '', isDirectory: true }] })).toBe(false)
    expect(isEntry({ ...entry, scope: [{ path: SRC.path }] })).toBe(false)
    expect(isEntry({ ...entry, scope: 'nope' })).toBe(false)
  })

  it('rejects a scope longer than the module’s own cap', () => {
    // 64 is what the writer truncates to, so a longer one was not written by
    // this module — and serving it, then carrying it through every later
    // merge-write, is how one hand-written line bloats every read.
    const entry = build()
    const scopeOf = (n: number): SyncScopeTarget[] =>
      Array.from({ length: n }, (_, i) => ({ path: `${ROOT}/f${i}.txt`, isDirectory: false }))
    expect(isEntry({ ...entry, scope: scopeOf(64) })).toBe(true)
    expect(isEntry({ ...entry, scope: scopeOf(65) })).toBe(false)
  })

  it('rejects malformed optional groups', () => {
    const entry = build()
    expect(isEntry({ ...entry, io: { readBytes: 1 } })).toBe(false)
    expect(isEntry({ ...entry, counts: { applied: 1 } })).toBe(false)
    expect(isEntry({ ...entry, error: { kind: 'x' } })).toBe(false)
    expect(isEntry({ ...entry, engine: 'git' })).toBe(false)
  })
})

describe('toRunDto / toRunDetailDto', () => {
  it('trims the list scope to three while reporting the full count', () => {
    const scope: SyncScopeTarget[] = Array.from({ length: 5 }, (_, i) => ({
      path: `${ROOT}/f${i}.txt`,
      isDirectory: false,
    }))
    const entry = build({ scope })
    const dto = toRunDto(entry)
    expect(dto.scopeFirst).toHaveLength(3)
    expect(dto.scopeCount).toBe(5)
    expect(dto.scopeFirst[0]).toEqual({ path: `${ROOT}/f0.txt`, isDirectory: false })
  })

  it('counts truncated scope entries in scopeCount', () => {
    const scope: SyncScopeTarget[] = Array.from({ length: 100 }, (_, i) => ({
      path: `${ROOT}/f${i}.txt`,
      isDirectory: false,
    }))
    const dto = toRunDto(build({ scope }))
    expect(dto.scopeCount).toBe(100)
  })

  it('carries the full scope and the omitted count in the detail DTO', () => {
    const scope: SyncScopeTarget[] = Array.from({ length: 100 }, (_, i) => ({
      path: `${ROOT}/f${i}.txt`,
      isDirectory: false,
    }))
    const detail = toRunDetailDto(build({ scope }))
    expect(detail.scope).toHaveLength(64)
    expect(detail.scopeOmitted).toBe(36)
  })

  it('omits optional groups rather than setting them undefined', () => {
    const dto = toRunDto(build({ run: undefined, outcome: 'declined' }))
    expect('io' in dto).toBe(false)
    expect('engine' in dto).toBe(false)
    expect('counts' in dto).toBe(false)
    expect('error' in dto).toBe(false)
  })
})
