import { describe, expect, it } from 'vitest'
import { summarizeRun, toReconcileFiles } from '../p4deltaParser.js'
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
      counts: { add: 100, edit: 240 },
      total: 340,
      unmatched: 0,
      reason: null,
    })
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
