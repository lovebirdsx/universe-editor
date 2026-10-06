import { describe, expect, it } from 'vitest'
import {
  appliedSyncFiles,
  summarizeRun,
  toReconcileFiles,
  toSyncOutcome,
} from '../p4deltaParser.js'
import type { P4deltaRunResult } from '../p4deltaService.js'

const CLIENT_ROOT = '/p4ws/main'

/** A contract-shaped `kind:"file"` record; overrides model the variants. */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'file',
    mode: 'open',
    class: 'edit',
    action: 'edit',
    depotFile: '//depot/main/src/a.ts',
    clientFile: '//main/src/a.ts',
    rev: '3',
    applied: false,
    ...overrides,
  }
}

function runOf(records: Record<string, unknown>[]): P4deltaRunResult {
  return {
    code: 0,
    records,
    progress: [],
    log: [],
    sawNonJsonStdout: false,
    sawSummary: records.some((r) => r['kind'] === 'summary'),
    signal: null,
  }
}

describe('toReconcileFiles', () => {
  it('maps a client-syntax file record to a drift row with a local path', () => {
    expect(toReconcileFiles([file()], CLIENT_ROOT)).toEqual([
      {
        depotFile: '//depot/main/src/a.ts',
        clientFile: '/p4ws/main/src/a.ts',
        action: 'edit',
        rev: '3',
      },
    ])
  })

  it('keeps a newly added file without a rev', () => {
    const rows = toReconcileFiles(
      [
        file({
          class: 'add',
          action: 'add',
          depotFile: '//depot/main/src/new.ts',
          clientFile: '//main/src/new.ts',
          rev: undefined,
        }),
      ],
      CLIENT_ROOT,
    )
    expect(rows).toEqual([
      {
        depotFile: '//depot/main/src/new.ts',
        clientFile: '/p4ws/main/src/new.ts',
        action: 'add',
        rev: undefined,
      },
    ])
  })

  // δ's open mode also re-opens files opened the other way; their `action` is the
  // p4 wording native `reconcile -n` reports for the same situation, so they are
  // drift rows exactly like the native engine's.
  it('keeps the reopen groups, whose actions match the native -Mj records', () => {
    const rows = toReconcileFiles(
      [
        file({ class: 'reopen_edit', action: 'edit' }),
        file({ class: 'reopen_delete', action: 'delete', depotFile: '//depot/main/src/b.ts' }),
      ],
      CLIENT_ROOT,
    )
    expect(rows.map((r) => r.action)).toEqual(['edit', 'delete'])
  })

  it('drops the revert / handoff groups and anything else instead of calling it an edit', () => {
    const rows = toReconcileFiles(
      [
        // `p4 revert -a` semantics, not part of `reconcile -a -e -d`.
        file({ class: 'revert_add', action: 'revert' }),
        file({ class: 'revert_edit', action: 'revert' }),
        file({ class: 'revert_delete', action: 'revert' }),
        // Handed over to native p4 — no per-file action in this engine.
        file({ class: 'handoff', action: 'handoff', handoff: 'reconcile' }),
        // A mode that is not `open` (clean / sync speak a different taxonomy).
        file({ mode: 'clean', class: 'delete', action: 'deleting' }),
        // A record whose action this reader does not know at all.
        file({ class: 'mystery', action: 'unknown' }),
      ],
      CLIENT_ROOT,
    )
    expect(rows).toEqual([])
  })

  it('drops a file record with no depotFile', () => {
    expect(toReconcileFiles([file({ depotFile: undefined })], CLIENT_ROOT)).toEqual([])
  })

  it('ignores non-file records', () => {
    expect(
      toReconcileFiles(
        [
          { kind: 'summary', mode: 'open', ok: true },
          { kind: 'unmatched', path: '/p4ws/main/gone' },
          { kind: 'error', message: 'boom' },
        ],
        CLIENT_ROOT,
      ),
    ).toEqual([])
  })

  // When δ cannot work out a client root it degrades `clientFile` to the local
  // path (contract) — the value must survive verbatim, not be mangled.
  it('keeps a clientFile that is already a local path verbatim', () => {
    const rows = toReconcileFiles([file({ clientFile: 'X:/p4ws/main/src/a.ts' })], CLIENT_ROOT)
    expect(rows[0]?.clientFile).toBe('X:/p4ws/main/src/a.ts')
  })
})

describe('summarizeRun', () => {
  it('returns undefined when the stream has no summary — no summary means no conclusion', () => {
    expect(summarizeRun(runOf([]))).toBeUndefined()
    expect(summarizeRun(runOf([file(), { kind: 'progress', phase: 'digest' }]))).toBeUndefined()
  })

  it('reports an entry-less run as ok:false with its reason', () => {
    const summary = summarizeRun(
      runOf([
        { kind: 'unmatched', path: '/p4ws/main/gone' },
        { kind: 'unmatched', path: '/p4ws/main/gone/...' },
        {
          kind: 'summary',
          mode: 'open',
          ok: false,
          applied: false,
          total: 0,
          counts: {},
          scopeMatched: 0,
          unmatched: 2,
          elapsedMs: 12,
          reason: 'no-entry-matched',
        },
      ]),
    )
    expect(summary).toEqual({
      ok: false,
      mode: 'open',
      applied: false,
      force: false,
      counts: {},
      total: 0,
      unmatched: 2,
      reason: 'no-entry-matched',
    })
  })

  it('reads a successful summary', () => {
    const summary = summarizeRun(
      runOf([
        file(),
        {
          kind: 'summary',
          mode: 'open',
          ok: true,
          applied: false,
          total: 340,
          counts: { add: 100, edit: 240 },
          scopeMatched: 1,
          unmatched: 0,
          elapsedMs: 249,
          reason: null,
        },
      ]),
    )
    expect(summary).toEqual({
      ok: true,
      mode: 'open',
      applied: false,
      force: false,
      counts: { add: 100, edit: 240 },
      total: 340,
      unmatched: 0,
      reason: null,
    })
  })

  it('reads the force flag strictly, like applied', () => {
    const force = (value: unknown): boolean | undefined =>
      summarizeRun(runOf([{ kind: 'summary', mode: 'sync', ok: true, force: value, total: 1 }]))
        ?.force
    expect(force(true)).toBe(true)
    expect(force(false)).toBe(false)
    expect(force('true')).toBe(false)
    expect(force(undefined)).toBe(false)
  })

  it('reads applied strictly: only an explicit true counts', () => {
    const applied = (value: unknown): boolean | undefined =>
      summarizeRun(runOf([{ kind: 'summary', mode: 'open', ok: true, applied: value, total: 1 }]))
        ?.applied
    expect(applied(true)).toBe(true)
    expect(applied(false)).toBe(false)
    expect(applied('true')).toBe(false)
    expect(applied(undefined)).toBe(false)
  })

  it('takes the last summary of the stream', () => {
    const summary = summarizeRun(
      runOf([
        {
          kind: 'summary',
          mode: 'open',
          ok: true,
          total: 1,
          counts: { edit: 1 },
          unmatched: 0,
          reason: null,
        },
        {
          kind: 'summary',
          mode: 'open',
          ok: false,
          total: 0,
          counts: {},
          unmatched: 0,
          reason: 'error',
        },
      ]),
    )
    expect(summary?.ok).toBe(false)
    expect(summary?.reason).toBe('error')
  })

  it('does not read a missing ok as success', () => {
    expect(summarizeRun(runOf([{ kind: 'summary', mode: 'open', total: 3 }]))?.ok).toBe(false)
  })
})

// --- δ normal sync (`--sync`, no `--force`) ---------------------------------

/** One `kind:"file"` record of a sync run. `clientFile` is client syntax derived
 *  from the depot path, exactly as the contract has it. */
function syncFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const depotFile = (overrides['depotFile'] as string | undefined) ?? '//depot/main/src/a.ts'
  return {
    kind: 'file',
    mode: 'sync',
    class: 'update',
    action: 'updating',
    nativeAction: 'updated',
    depotFile,
    clientFile: depotFile.replace('//depot/', '//'),
    rev: '2',
    applied: true,
    stage: 'apply',
    ...overrides,
  }
}

function syncSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'summary',
    mode: 'sync',
    ok: true,
    applied: true,
    force: false,
    total: 0,
    counts: {},
    scopeMatched: null,
    unmatched: 0,
    elapsedMs: 9,
    reason: null,
    ...overrides,
  }
}

/** A concluded run: `records` under one summary, plus the engine's own human log
 *  (which is where p4's per-file refusal messages arrive under `--json`). */
function syncRun(
  records: Record<string, unknown>[],
  log: string[] = [],
  summary: Record<string, unknown> = {},
): P4deltaRunResult {
  return { ...runOf([...records, syncSummary(summary)]), log }
}

describe('toSyncOutcome', () => {
  it('maps the applied classes to rows and counts, preferring nativeAction', () => {
    const outcome = toSyncOutcome(
      syncRun([
        syncFile(),
        syncFile({
          class: 'add',
          action: 'adding',
          nativeAction: 'added',
          depotFile: '//depot/main/src/b.ts',
          rev: '1',
        }),
        syncFile({
          class: 'delete',
          action: 'deleting',
          nativeAction: 'deleted',
          depotFile: '//depot/main/src/c.ts',
          rev: '4',
        }),
      ]),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.appliedFiles).toEqual([
      {
        depotFile: '//depot/main/src/a.ts',
        clientFile: '/p4ws/main/src/a.ts',
        action: 'updated',
        rev: '2',
      },
      {
        depotFile: '//depot/main/src/b.ts',
        clientFile: '/p4ws/main/src/b.ts',
        action: 'added',
        rev: '1',
      },
      {
        depotFile: '//depot/main/src/c.ts',
        clientFile: '/p4ws/main/src/c.ts',
        action: 'deleted',
        rev: '4',
      },
    ])
    expect(outcome?.summary).toEqual({
      applied: 3,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      upToDate: false,
      unrecognized: false,
    })
  })

  // Native p4 prints BOTH "is opened and not being changed" and "must resolve
  // #N before submitting" for one opened file; the engine collapses the pair
  // into one `resolve` record, so it has to feed both counters or the get stops
  // offering the resolve button (and `recordSyncPoint` stops seeing work left).
  it('counts one resolve record as both keptOpen and mustResolve, and not as applied', () => {
    const outcome = toSyncOutcome(
      syncRun([
        syncFile({
          class: 'resolve',
          action: 'scheduling',
          nativeAction: undefined,
          depotFile: '//depot/main/src/open.ts',
        }),
      ]),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.appliedFiles).toEqual([])
    expect(outcome?.summary).toMatchObject({ applied: 0, keptOpen: 1, mustResolve: 1 })
  })

  it('reads the refusal lines back from the engine log', () => {
    const outcome = toSyncOutcome(
      syncRun(
        [],
        [
          `//depot/main/src/a.ts#3 - can't update modified file ${CLIENT_ROOT}/src/a.ts`,
          `//depot/main/src/b.ts#7 - can't overwrite existing file ${CLIENT_ROOT}/src/b.ts`,
        ],
        { total: 2 },
      ),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.summary).toMatchObject({
      applied: 0,
      keptOpen: 0,
      refusedModified: 1,
      refusedOverwrite: 1,
      upToDate: false,
      // A refusal IS an account of what happened, so it is not "unrecognized"
      // even though no file record explained the work.
      unrecognized: false,
    })
    expect(outcome?.refusedFiles).toEqual([
      {
        depotFile: '//depot/main/src/a.ts',
        clientFile: '/p4ws/main/src/a.ts',
        action: 'not updated',
        rev: '3',
      },
    ])
    expect(outcome?.refusedOverwriteFiles).toEqual([
      {
        depotFile: '//depot/main/src/b.ts',
        clientFile: '/p4ws/main/src/b.ts',
        action: 'not updated',
        rev: '7',
      },
    ])
  })

  it('reports a run with no work at all as up to date', () => {
    const outcome = toSyncOutcome(syncRun([]), CLIENT_ROOT, true)
    expect(outcome?.upToDate).toBe(true)
    expect(outcome?.summary.unrecognized).toBe(false)
  })

  // The summary claimed work and no record accounted for it — the caller must
  // log that instead of showing "0 applied" as a finished get.
  it('flags a summary whose work no record accounts for as unrecognized', () => {
    const outcome = toSyncOutcome(
      syncRun([], [], { total: 4, counts: { update: 4 } }),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.summary.unrecognized).toBe(true)
    expect(outcome?.upToDate).toBe(false)
  })

  it('has no conclusion without a summary, on a failed one, or for another mode', () => {
    const records = [syncFile()]
    expect(toSyncOutcome(runOf(records), CLIENT_ROOT, true)).toBeUndefined()
    expect(
      toSyncOutcome(syncRun(records, [], { ok: false, reason: 'error' }), CLIENT_ROOT, true),
    ).toBeUndefined()
    expect(toSyncOutcome(syncRun(records, [], { mode: 'open' }), CLIENT_ROOT, true)).toBeUndefined()
  })

  it('has no conclusion when the run answered the other direction', () => {
    // A preview-shaped stream must never be read as the write that was asked
    // for — nor the write as the preview it is asked to be.
    expect(
      toSyncOutcome(syncRun([syncFile()], [], { applied: false }), CLIENT_ROOT, true),
    ).toBeUndefined()
    expect(toSyncOutcome(syncRun([syncFile()]), CLIENT_ROOT, false)).toBeUndefined()
  })

  // The one question a force summary must never be read as: "your local work is
  // untouched". The editor never asks δ for one, so seeing it means the engine
  // ran something else entirely.
  it('has no conclusion for a force run, which shares this mode', () => {
    expect(
      toSyncOutcome(syncRun([syncFile()], [], { force: true }), CLIENT_ROOT, true),
    ).toBeUndefined()
  })

  // `handoff` and the force classes (`revert`/`restore`) come from another mode's
  // vocabulary: the stream is answering a question nobody asked.
  it('has no conclusion for a record outside the normal-sync classes', () => {
    for (const foreign of [
      { class: 'handoff', action: 'handoff' },
      { class: 'revert', action: 'reverting' },
      { class: 'restore', action: 'restoring' },
      { class: undefined, action: undefined },
    ]) {
      expect(toSyncOutcome(syncRun([syncFile(foreign)]), CLIENT_ROOT, true)).toBeUndefined()
    }
  })

  it('drops a file record with no depot path instead of inventing a row', () => {
    const outcome = toSyncOutcome(
      syncRun([syncFile({ depotFile: undefined })], [], { total: 1 }),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.appliedFiles).toEqual([])
    expect(outcome?.summary.unrecognized).toBe(true)
  })

  it('keeps a clientFile that is already a local path verbatim', () => {
    const outcome = toSyncOutcome(
      syncRun([syncFile({ clientFile: 'X:/p4ws/main/src/a.ts' })]),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.appliedFiles[0]?.clientFile).toBe('X:/p4ws/main/src/a.ts')
  })
})

describe('appliedSyncFiles', () => {
  // The cancelled-run reader: a killed stream has no summary by construction, so
  // only the records that already arrived can say what landed.
  it('reads the applied rows out of a summary-less stream', () => {
    expect(
      appliedSyncFiles(
        [
          syncFile({ depotFile: '//depot/main/src/b.ts' }),
          // An opened file whose have moved: content untouched, so no drift row.
          syncFile({
            class: 'resolve',
            action: 'scheduling',
            depotFile: '//depot/main/src/open.ts',
          }),
          { kind: 'progress', phase: 'apply' },
        ],
        CLIENT_ROOT,
      ),
    ).toEqual([
      {
        depotFile: '//depot/main/src/b.ts',
        clientFile: '/p4ws/main/src/b.ts',
        action: 'updated',
        rev: '2',
      },
    ])
  })

  // A cancelled get subtracts these rows from the drift set, and that is the one
  // mistake here that HIDES local work: a file the engine only previewed would
  // lose the row that tells the user their edits are uncollected. The contract
  // says an `-a` run emits apply-segment records only; this reader checks rather
  // than assumes, so a build that reported its plan on the way in costs a stale
  // row instead of a silent one.
  it('ignores a record that is only a preview of what the run would do', () => {
    expect(
      appliedSyncFiles(
        [
          syncFile({ depotFile: '//depot/main/src/planned.ts', stage: 'preview' }),
          // No `stage` at all: a record that does not carry the apply marker is
          // not evidence of a write either.
          syncFile({ depotFile: '//depot/main/src/unmarked.ts', stage: undefined }),
        ],
        CLIENT_ROOT,
      ),
    ).toEqual([])
  })
})
