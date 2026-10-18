import { describe, expect, it } from 'vitest'
import {
  appliedSyncFiles,
  readP4deltaCallCount,
  summarizeRun,
  toReconcileFiles,
  toSyncOutcome,
} from '../p4delta/p4deltaParser.js'
import type { P4deltaRunResult } from '../p4delta/p4deltaService.js'

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
    runId: 'p4d-test-1-1-aaaa',
    startedAt: 1_700_000_000_000,
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

  // `conflicts` 是普通同步专有的账目。契约保证每轮都发；读取器不替缺席的流补 0——
  // undefined 是 `toSyncOutcome` 判定「这份流没有结论」的依据。
  it('reads the conflict tally, and leaves an omitted field undefined', () => {
    const summary = (conflicts?: number): Record<string, unknown> => ({
      kind: 'summary',
      mode: 'sync',
      ok: true,
      total: 0,
      counts: {},
      ...(conflicts === undefined ? {} : { conflicts }),
    })
    expect(summarizeRun(runOf([summary(2)]))?.conflicts).toBe(2)
    expect(summarizeRun(runOf([summary(0)]))?.conflicts).toBe(0)
    expect(summarizeRun(runOf([summary()]))?.conflicts).toBeUndefined()
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

/** One `kind:"conflict"` record — a normal sync's per-file refusal, structurally. */
function conflict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'conflict',
    mode: 'sync',
    reason: 'update-modified',
    action: 'not updated',
    depotFile: '//depot/main/src/a.ts',
    clientFile: '//main/src/a.ts',
    rev: '2',
    stage: 'apply',
    applied: true,
    force: false,
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
    conflicts: 0,
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
      trackedDeleted: 1,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      handoff: 0,
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

  it('reports a run with no work at all as up to date', () => {
    const outcome = toSyncOutcome(syncRun([]), CLIENT_ROOT, true)
    expect(outcome?.upToDate).toBe(true)
    expect(outcome?.summary.unrecognized).toBe(false)
  })

  // 新引擎为每条拒绝发一条 `kind:"conflict"`。记录优先于 stderr 正则——两源合并会把同一条
  // 拒绝算两遍，补救按钮也会重复。
  it('reads structured conflict records instead of re-parsing the log', () => {
    const outcome = toSyncOutcome(
      syncRun(
        [
          conflict(),
          conflict({
            reason: 'delete-modified',
            action: 'not deleted',
            depotFile: '//depot/main/src/gone.ts',
            clientFile: '//main/src/gone.ts',
            rev: '1',
          }),
          conflict({
            reason: 'overwrite-existing',
            depotFile: '//depot/main/src/b.ts',
            clientFile: '//main/src/b.ts',
            rev: '7',
          }),
        ],
        [
          // 同一批拒绝也由引擎原样转写在 stderr 上：结构化记录存在时这里一条都不该读。
          `//depot/main/src/a.ts#2 - can't update modified file ${CLIENT_ROOT}/src/a.ts`,
          `//depot/main/src/gone.ts#1 - can't delete modified file ${CLIENT_ROOT}/src/gone.ts`,
        ],
        { total: 0, conflicts: 3 },
      ),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.refusedFiles).toEqual([
      {
        depotFile: '//depot/main/src/a.ts',
        clientFile: '/p4ws/main/src/a.ts',
        action: 'not updated',
        rev: '2',
      },
      {
        depotFile: '//depot/main/src/gone.ts',
        clientFile: '/p4ws/main/src/gone.ts',
        action: 'not deleted',
        rev: '1',
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
    expect(outcome?.summary).toMatchObject({
      applied: 0,
      refusedModified: 2,
      refusedOverwrite: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  // summary 说有几条冲突、记录流却少了一条：流是残缺的，不能拿它当结论。
  it('has no conclusion when the summary conflict count disagrees with the records', () => {
    expect(
      toSyncOutcome(syncRun([conflict()], [], { conflicts: 2 }), CLIENT_ROOT, true),
    ).toBeUndefined()
    expect(
      toSyncOutcome(syncRun([conflict()], [], { conflicts: 0 }), CLIENT_ROOT, true),
    ).toBeUndefined()
  })

  // 契约保证 summary 恒发 `conflicts`；缺席的流没有结论，stderr 文本救不回来。
  it('has no conclusion when the summary omits the conflict tally', () => {
    expect(
      toSyncOutcome(
        syncRun(
          [],
          [`//depot/main/src/a.ts#2 - can't update modified file ${CLIENT_ROOT}/src/a.ts`],
          { total: 1, conflicts: undefined },
        ),
        CLIENT_ROOT,
        true,
      ),
    ).toBeUndefined()
  })

  // 认不出的 reason 说明引擎引入了我们没有补救方案的拒绝形态；返回 undefined 让普通 get
  // 回退原生，绝不按「没发生」处理。
  it('has no conclusion for an unknown conflict reason', () => {
    expect(
      toSyncOutcome(
        syncRun([conflict({ reason: 'future-shape' })], [], { conflicts: 1 }),
        CLIENT_ROOT,
        true,
      ),
    ).toBeUndefined()
  })

  // 强制修复不走原生逐文件保护：这一档里出现冲突记录说明流串了档。
  it('has no conclusion for conflict records in a force run', () => {
    expect(
      toSyncOutcome(
        runOf([conflict(), syncSummary({ force: true, conflicts: 1 })]),
        CLIENT_ROOT,
        true,
        true,
      ),
    ).toBeUndefined()
  })

  // 契约保证每轮都发 `conflicts`（可以是 0）。范围过滤掉的拒绝仍留在 stderr 上，
  // 但编辑器只读记录：文本里的行永远不能被重新算进来。
  it('does not read stderr text even when the conflict count is zero', () => {
    const outcome = toSyncOutcome(
      syncRun(
        [],
        [`//depot/main/src/a.ts#3 - can't update modified file ${CLIENT_ROOT}/src/a.ts`],
        { total: 0, counts: {}, conflicts: 0 },
      ),
      CLIENT_ROOT,
      true,
    )
    expect(outcome?.refusedFiles).toEqual([])
    expect(outcome?.summary).toMatchObject({
      applied: 0,
      refusedModified: 0,
      upToDate: true,
    })
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

  // 普通 get 收到 force summary，等于流在回答另一个问题（修复档由下面专门的用例认领）。
  it('has no conclusion for a force run, which shares this mode', () => {
    expect(
      toSyncOutcome(syncRun([syncFile()], [], { force: true }), CLIENT_ROOT, true),
    ).toBeUndefined()
  })

  // 两档共有 `mode` 与部分类表，所以两个类表互为对方的「异类」。
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

// --- δ force repair (`--sync --force`) --------------------------------------

/** 强制修复档的一条 `kind:"file"` 记录：同样是 `mode:"sync"`，用自己的类表
 *  （`update` / `revert` / `restore` / `delete`），且没有普通 get 的 `stage` 标记。 */
function forceFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const depotFile = (overrides['depotFile'] as string | undefined) ?? '//depot/main/src/a.ts'
  return {
    kind: 'file',
    mode: 'sync',
    class: 'update',
    action: 'updating',
    depotFile,
    clientFile: depotFile.replace('//depot/', '//'),
    rev: '2',
    applied: true,
    force: true,
    ...overrides,
  }
}

/** 一次有结论的强制修复。 */
function forceRun(
  records: Record<string, unknown>[],
  log: string[] = [],
  summary: Record<string, unknown> = {},
): P4deltaRunResult {
  return syncRun(records, log, { force: true, ...summary })
}

describe('toSyncOutcome — force repair', () => {
  it('maps the four repair classes to applied rows when the get asked for force', () => {
    const outcome = toSyncOutcome(
      forceRun(
        [
          forceFile(),
          forceFile({ class: 'revert', action: 'reverting', depotFile: '//depot/main/src/b.ts' }),
          forceFile({
            class: 'restore',
            action: 'restoring',
            depotFile: '//depot/main/src/c.ts',
          }),
          forceFile({ class: 'delete', action: 'deleting', depotFile: '//depot/main/src/d.ts' }),
        ],
        [],
        { total: 4, counts: { update: 1, revert: 1, restore: 1, delete: 1 } },
      ),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.appliedFiles).toEqual([
      {
        depotFile: '//depot/main/src/a.ts',
        clientFile: '/p4ws/main/src/a.ts',
        action: 'updating',
        rev: '2',
      },
      {
        depotFile: '//depot/main/src/b.ts',
        clientFile: '/p4ws/main/src/b.ts',
        action: 'reverting',
        rev: '2',
      },
      {
        depotFile: '//depot/main/src/c.ts',
        clientFile: '/p4ws/main/src/c.ts',
        action: 'restoring',
        rev: '2',
      },
      {
        depotFile: '//depot/main/src/d.ts',
        clientFile: '/p4ws/main/src/d.ts',
        action: 'deleting',
        rev: '2',
      },
    ])
    expect(outcome?.summary).toMatchObject({
      applied: 4,
      trackedDeleted: 1,
      handoff: 0,
      upToDate: false,
      unrecognized: false,
    })
  })

  it('requires the force flag to match the request, in both directions', () => {
    // 把修复读成普通 get 是最不能发生的一读：被覆盖的本地改动会变成一次普通拉取。
    expect(toSyncOutcome(forceRun([forceFile()]), CLIENT_ROOT, true)).toBeUndefined()
    // force:false 的回答（忽略了 `--force` 的构建，或普通 get 的形状）不是用户要的修复。
    expect(toSyncOutcome(syncRun([syncFile()]), CLIENT_ROOT, true, true)).toBeUndefined()
  })

  it('answers only a request that was applied — a preview is not the repair', () => {
    expect(
      toSyncOutcome(forceRun([forceFile()], [], { applied: false }), CLIENT_ROOT, true, true),
    ).toBeUndefined()
    expect(toSyncOutcome(forceRun([forceFile()]), CLIENT_ROOT, false, true)).toBeUndefined()
  })

  it('has no conclusion without a summary, on a failed one, or for another mode', () => {
    expect(toSyncOutcome(runOf([forceFile()]), CLIENT_ROOT, true, true)).toBeUndefined()
    expect(
      toSyncOutcome(
        forceRun([forceFile()], [], { ok: false, reason: 'error' }),
        CLIENT_ROOT,
        true,
        true,
      ),
    ).toBeUndefined()
    expect(
      toSyncOutcome(forceRun([forceFile()], [], { mode: 'clean' }), CLIENT_ROOT, true, true),
    ).toBeUndefined()
  })

  // δ 处理不了的文件整批转交原生 `p4 sync -f`，记为 `class:"handoff"`：只知那条命令成功，
  // 没有逐文件证据，所以单独计数，绝不混进调用方用来扣漂移的 applied 行。
  it('counts a handoff as its own tally, never as an applied row', () => {
    const outcome = toSyncOutcome(
      forceRun(
        [
          forceFile(),
          forceFile({
            class: 'handoff',
            action: 'sync',
            handoff: 'sync',
            depotFile: '//depot/main/src/bin.bin',
            rev: undefined,
          }),
        ],
        [],
        { total: 1, counts: { update: 1 } },
      ),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.appliedFiles.map((f) => f.depotFile)).toEqual(['//depot/main/src/a.ts'])
    expect(outcome?.summary).toMatchObject({
      applied: 1,
      handoff: 1,
      upToDate: false,
      // handoff 已经解释了账本为什么不提它，所以不算「无法识别」。
      unrecognized: false,
    })
  })

  it('reports a handoff-only repair as work done, not as up to date', () => {
    const outcome = toSyncOutcome(
      forceRun([forceFile({ class: 'handoff', action: 'sync', handoff: 'sync' })], [], {
        total: 0,
        counts: {},
      }),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.appliedFiles).toEqual([])
    expect(outcome?.summary).toMatchObject({
      applied: 0,
      handoff: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  it('has no conclusion for a handoff bound for another mode', () => {
    // handoff 字段写明交给了哪条原生命令；sync 档里冒出 `clean` 说明是别档的流。
    expect(
      toSyncOutcome(
        forceRun([forceFile({ class: 'handoff', action: 'clean', handoff: 'clean' })]),
        CLIENT_ROOT,
        true,
        true,
      ),
    ).toBeUndefined()
  })

  // `resolve` 属于普通 get，`add` 也不在修复档的类表里（`added` 映射成 `restore`），
  // 出现任一个都说明这不是用户要的修复。
  it('has no conclusion for a record outside the force classes', () => {
    for (const foreign of [
      { class: 'resolve', action: 'scheduling' },
      { class: 'add', action: 'adding' },
      { class: undefined, action: undefined },
    ]) {
      expect(toSyncOutcome(forceRun([forceFile(foreign)]), CLIENT_ROOT, true, true)).toBeUndefined()
    }
  })

  it('reports a repair with no work at all as up to date', () => {
    const outcome = toSyncOutcome(forceRun([]), CLIENT_ROOT, true, true)
    expect(outcome?.upToDate).toBe(true)
    expect(outcome?.summary.handoff).toBe(0)
  })

  // `--delete-untracked` 删掉的文件也进 appliedFiles（它们的漂移行同样作废），但汇总里
  // 单独计数、从 applied 扣除——「同步了几个文件」与「清掉几个 depot 从不跟踪的文件」
  // 不是同一件事，历史要分开显示。
  it('reports untracked deletions apart from the files it synced', () => {
    const outcome = toSyncOutcome(
      forceRun(
        [
          forceFile(),
          forceFile({
            class: 'untracked',
            action: 'deleting',
            depotFile: '//depot/main/junk.log',
            clientFile: '//main/junk.log',
            rev: undefined,
          }),
        ],
        [],
        { total: 2, counts: { update: 1, untracked: 1 } },
      ),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.appliedFiles.map((file) => file.depotFile)).toEqual([
      '//depot/main/src/a.ts',
      '//depot/main/junk.log',
    ])
    expect(outcome?.summary).toMatchObject({
      applied: 1,
      untrackedDeleted: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  // 强制修复里两类删除同时出现：已跟踪删除是 applied 的子集，未跟踪删除在 applied 之外。
  // `applied` = 3 条 applied 记录减去 1 条 untracked = 2；`trackedDeleted` 只数 delete 类。
  it('separates tracked deletions from untracked deletions', () => {
    const outcome = toSyncOutcome(
      forceRun(
        [
          forceFile(),
          forceFile({ class: 'delete', action: 'deleting', depotFile: '//depot/main/src/gone.ts' }),
          forceFile({
            class: 'untracked',
            action: 'deleting',
            depotFile: '//depot/main/junk.log',
            rev: undefined,
          }),
        ],
        [],
        { total: 3, counts: { update: 1, delete: 1, untracked: 1 } },
      ),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.summary).toMatchObject({
      applied: 2,
      trackedDeleted: 1,
      untrackedDeleted: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  // 只删未跟踪文件的一轮同样是「干了活」，不能报成已是最新或无法识别。
  it('reports an untracked-only repair as work done', () => {
    const outcome = toSyncOutcome(
      forceRun(
        [
          forceFile({
            class: 'untracked',
            action: 'deleting',
            depotFile: '//depot/main/junk.log',
            clientFile: '//main/junk.log',
            rev: undefined,
          }),
        ],
        [],
        { total: 1, counts: { untracked: 1 } },
      ),
      CLIENT_ROOT,
      true,
      true,
    )
    expect(outcome?.summary).toMatchObject({
      applied: 0,
      untrackedDeleted: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  // 计数跟着行一起成立：一条记不出身份的 untracked 记录若只计数不建行，
  // `applied - untrackedDeleted` 会变成负数并写进历史。这样的流回答不了问题。
  it('has no conclusion for an untracked record without an identity', () => {
    expect(
      toSyncOutcome(
        forceRun(
          [
            forceFile({
              class: 'untracked',
              action: 'deleting',
              depotFile: undefined,
              rev: undefined,
            }),
          ],
          [],
          { total: 1, counts: { untracked: 1 } },
        ),
        CLIENT_ROOT,
        true,
        true,
      ),
    ).toBeUndefined()
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

  // 被取消的强制修复记录里没有 `stage`，这个读取器必须什么都读不到：为一次被杀掉的修复扣漂移，
  // 只会把已被覆盖的本地改动藏起来。
  it('reads nothing out of a force repair, whose records carry no apply marker', () => {
    expect(appliedSyncFiles([forceFile()], CLIENT_ROOT)).toEqual([])
  })
})

describe('readP4deltaCallCount', () => {
  it('takes the highest cumulative event and the summary’s final number', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 0, command: null },
      { kind: 'p4CommandCount', count: 1, command: 'set' },
      { kind: 'p4CommandCount', count: 5, command: 'fstat' },
      { kind: 'summary', p4Calls: 5, p4CallsByCommand: { set: 1, fstat: 4 } },
    ])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 5,
      reported: 5,
      observedByCommand: { set: 1, fstat: 1 },
      reportedByCommand: { set: 1, fstat: 4 },
      reportedByCommandComplete: true,
    })
  })

  it('keeps the high-water mark as a lower bound when no summary arrived', () => {
    // A killed / cancelled / crashed run: the events that made it out are all
    // the evidence there is, and the consumer must mark the total incomplete.
    const run = runOf([{ kind: 'p4CommandCount', count: 3, command: 'have' }])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 3,
      reported: undefined,
      observedByCommand: { have: 1 },
      reportedByCommand: undefined,
      reportedByCommandComplete: false,
    })
  })

  it('drops malformed events instead of trusting them', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: -1, command: 'set' },
      { kind: 'p4CommandCount', count: Number.NaN, command: 'set' },
      { kind: 'p4CommandCount', count: 1.5, command: 'set' },
      { kind: 'p4CommandCount', count: Number.MAX_SAFE_INTEGER + 1, command: 'set' },
      { kind: 'p4CommandCount', count: '4', command: 'set' },
      { kind: 'p4CommandCount' },
      { kind: 'p4CommandCount', count: 2, command: 'sync' },
    ])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 2,
      reported: undefined,
      observedByCommand: { sync: 1 },
      reportedByCommand: undefined,
      reportedByCommandComplete: false,
    })
  })

  // 并发下 count 大的事件可能先到：按 count 去重计已知事件，而不是拿 count<=observed 过滤
  // （那会把乱序到达的合法事件整条丢掉，让分类凭空少一笔）。
  it('counts an out-of-order event once and a repeated count not at all', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 3, command: 'sync' },
      { kind: 'p4CommandCount', count: 2, command: 'have' },
      { kind: 'p4CommandCount', count: 1, command: 'set' },
      // 重复的 count（同一事件被读了两遍）不能再给 have 加一笔。
      { kind: 'p4CommandCount', count: 2, command: 'have' },
    ])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 3,
      reported: undefined,
      observedByCommand: { set: 1, have: 1, sync: 1 },
      reportedByCommand: undefined,
      reportedByCommandComplete: false,
    })
  })

  // 坏 0 事件（还没起任何进程）不能凭空给某个类别加一笔。
  it('ignores a zero-count event for the classification', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 0, command: 'set' },
      { kind: 'p4CommandCount', count: 0, command: 'set' },
    ])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 0,
      reported: undefined,
      observedByCommand: {},
      reportedByCommand: undefined,
      reportedByCommandComplete: false,
    })
  })

  it('ignores a malformed summary count and keeps a valid later one', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 0, command: null },
      { kind: 'summary', p4Calls: 'many', p4CallsByCommand: { sync: 2 } },
      { kind: 'summary', p4Calls: 4 },
    ])
    expect(readP4deltaCallCount(run)).toEqual({
      observed: 0,
      reported: 4,
      observedByCommand: {},
      // The last summary wins for the tally too — a stale classification must
      // not survive beside the newer total it belongs to.
      reportedByCommand: undefined,
      // 只说了总数（4）、没说分类：分类不完整，退回事件流那一份。
      reportedByCommandComplete: false,
    })
  })

  // 受控键：契约说新类别可以加，消费方按未知值忽略；手写/伪造的键同样进不来。
  it('rejects commands outside the contract’s fixed set', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 1, command: 'rm -rf' },
      { kind: 'p4CommandCount', count: 2, command: 'submit' },
      { kind: 'p4CommandCount', count: 3, command: 'sync' },
      { kind: 'summary', p4Calls: 3, p4CallsByCommand: { sync: 1, nonsense: 9, submit: 2 } },
    ])
    const counts = readP4deltaCallCount(run)
    expect(counts.observedByCommand).toEqual({ sync: 1 })
    expect(counts.reportedByCommand).toEqual({ sync: 1 })
    // 丢掉的条目（nonsense / submit）让这份账对不上任何总数，绝不能冒称完整。
    expect(counts.reportedByCommandComplete).toBe(false)
  })

  it('drops malformed classification entries', () => {
    const run = runOf([
      {
        kind: 'summary',
        p4Calls: 2,
        p4CallsByCommand: { have: -3, fstat: 1.5, where: 2 },
      },
    ])
    const counts = readP4deltaCallCount(run)
    expect(counts.reportedByCommand).toEqual({ where: 2 })
    expect(counts.reportedByCommandComplete).toBe(false)
  })

  // 合法的 0 是承诺范围内的**非负计数**：内部只保留非零项，所以它不进分类结果，但它不该把一份
  // 与总数自洽的账降级成下界（把它当非法值会让「have 0 次」这一类的引擎永远只能答下界）。
  it('skips a legitimate zero entry without downgrading the tally', () => {
    const run = runOf([{ kind: 'summary', p4Calls: 2, p4CallsByCommand: { sync: 2, have: 0 } }])
    const counts = readP4deltaCallCount(run)
    expect(counts.reportedByCommand).toEqual({ sync: 2 })
    expect(counts.reportedByCommandComplete).toBe(true)
  })

  // 分类完整性独立于总数：总和对得上但分类缺条目 / 对不上，都不能算完整。
  it('does not claim a complete classification whose sum misses the total', () => {
    const run = runOf([{ kind: 'summary', p4Calls: 9, p4CallsByCommand: { sync: 5, have: 3 } }])
    expect(readP4deltaCallCount(run).reportedByCommandComplete).toBe(false)
  })

  it('refuses a classification whose category exceeds the total', () => {
    // 「不能信大于总数的分类」：一笔对不上账的类别，整份不可信。
    const run = runOf([{ kind: 'summary', p4Calls: 5, p4CallsByCommand: { sync: 9 } }])
    expect(readP4deltaCallCount(run).reportedByCommandComplete).toBe(false)
  })

  it('refuses a classification below what the event stream observed', () => {
    // summary 说 sync 只跑了 1 次，事件流却已经看到 2 次（单类 >= 已观测）。
    const run = runOf([
      { kind: 'p4CommandCount', count: 1, command: 'sync' },
      { kind: 'p4CommandCount', count: 2, command: 'sync' },
      { kind: 'summary', p4Calls: 2, p4CallsByCommand: { sync: 1, have: 1 } },
    ])
    const counts = readP4deltaCallCount(run)
    expect(counts.observedByCommand).toEqual({ sync: 2 })
    expect(counts.reportedByCommandComplete).toBe(false)
  })

  // summary 漏掉**一整类**、数目却与总数自洽（1 = 1）：只遍历 summary 的项就会把这份账冒称
  // 完整，而事件流已经记下 sync 跑过一次。缺条目与数值偏小同样是账不平，所以两边的键都要走。
  it('refuses a classification that omits a class the event stream observed', () => {
    const run = runOf([
      { kind: 'p4CommandCount', count: 1, command: 'sync' },
      { kind: 'summary', p4Calls: 1, p4CallsByCommand: { fstat: 1 } },
    ])
    const counts = readP4deltaCallCount(run)
    expect(counts.observedByCommand).toEqual({ sync: 1 })
    expect(counts.reportedByCommand).toEqual({ fstat: 1 })
    expect(counts.reportedByCommandComplete).toBe(false)
  })

  it('reports nothing observed and nothing reported for a bare stream', () => {
    expect(readP4deltaCallCount(runOf([]))).toEqual({
      observed: 0,
      reported: undefined,
      observedByCommand: {},
      reportedByCommand: undefined,
      reportedByCommandComplete: false,
    })
  })
})
