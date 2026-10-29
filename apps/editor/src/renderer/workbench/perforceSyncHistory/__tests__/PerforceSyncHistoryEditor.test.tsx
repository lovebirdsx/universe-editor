/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Sync History page: it loads the run list over the
 *  extension commands, keeps the selection in step with the list, and — the part
 *  worth a test — never renders a missing measurement as a zero. The three
 *  degradation rules (no records / no sampler / no δ thread count) are asserted
 *  exactly as the wire contract states them.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  ICommandService,
  InstantiationService,
  IStorageService,
  ServiceCollection,
  StorageScope,
} from '@universe-editor/platform'
import {
  PerforceSyncHistoryCommands,
  type P4SyncHistoryLoadResult,
  type P4SyncRunDetailDto,
  type P4SyncRunDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  _resetForTests,
  noteSyncHistoryRecorded,
  perforceSyncHistoryViewState,
  SYNC_HISTORY_POKE_DEBOUNCE_MS,
} from '../../../services/perforceSyncHistory/syncHistoryViewState.js'
import { ExportPerforceSyncHistoryAction } from '../../../actions/perforceSyncHistoryActions.js'
import { PerforceSyncHistoryEditorInput } from '../../../services/editor/PerforceSyncHistoryEditorInput.js'
import { PerforceSyncHistoryEditor } from '../PerforceSyncHistoryEditor.js'

const ROOT = 'X:/p4ws/main'

function makeRun(overrides: Partial<P4SyncRunDto> = {}): P4SyncRunDto {
  return {
    id: 'run-1',
    at: Date.now() - 60_000,
    startedAt: Date.now() - 61_200,
    durationMs: 1200,
    clientRoot: ROOT,
    spec: '#head',
    force: false,
    trigger: 'explorer',
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

function makeDetail(run: P4SyncRunDto): P4SyncRunDetailDto {
  return { ...run, scope: run.scopeFirst, scopeOmitted: run.scopeCount - run.scopeFirst.length }
}

function makePage(runs: readonly P4SyncRunDto[], total = runs.length, hasMore = false) {
  return { runs, total, hasMore } satisfies P4SyncHistoryLoadResult
}

function makeCommandService(
  page: P4SyncHistoryLoadResult,
  details: Map<string, P4SyncRunDetailDto>,
): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string, arg?: unknown) => {
      if (id === PerforceSyncHistoryCommands.getRuns) return page
      if (id === PerforceSyncHistoryCommands.getRun) {
        // `null` for an id the store does not have — that is what the extension
        // answers, and `undefined` is reserved for the command not existing.
        return details.get(String(arg)) ?? null
      }
      return undefined
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService
}

function makeStorageService(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function renderEditor(commandService: ICommandService, storage = makeStorageService()) {
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  services.set(IStorageService, storage)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceSyncHistoryEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return { storage, ...utils }
}

/** Mimics EditorGroupView's activation focus: a parent layout effect runs after
 *  the child's layout effects but before any passive effect, so a registration
 *  that is still passive has not happened yet at this point. */
function ActivationFocusProbe({
  input,
  onHandled,
  children,
}: {
  input: PerforceSyncHistoryEditorInput
  onHandled: (handled: boolean) => void
  children: ReactNode
}) {
  const fired = useRef(false)
  useLayoutEffect(() => {
    if (fired.current) return
    fired.current = true
    onHandled(input.focus())
  })
  return <>{children}</>
}

/** Let the mount → getRuns → setState → getRun chain settle. The macrotask
 *  round is load-bearing: a state update arriving outside `act` is applied on
 *  React's scheduler, not on the microtask queue. */
async function flush(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

beforeEach(() => {
  _resetForTests()
})

afterEach(() => {
  _resetForTests()
})

describe('PerforceSyncHistoryEditor', () => {
  it('lists the runs and shows the count and the selected run', async () => {
    const first = makeRun({ id: 'run-1' })
    const second = makeRun({ id: 'run-2', spec: '@4521', outcome: 'failed' })
    const details = new Map([
      ['run-1', makeDetail(first)],
      ['run-2', makeDetail(second)],
    ])
    renderEditor(makeCommandService(makePage([first, second], 7, true), details))
    await flush()

    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(2)
    expect(screen.getByTestId('perforce-sync-history-count').textContent).toBe('7 run(s)')
    // Selection defaults to the newest run, so the pane is never blank while a
    // list is on screen.
    expect(screen.getByTestId('perforce-sync-history-detail-target').textContent).toContain('#head')
    expect(screen.getByTestId('perforce-sync-history-load-more')).toBeTruthy()
  })

  it('focuses the run list during the opening activation, before passive effects', async () => {
    const run = makeRun()
    const services = new ServiceCollection()
    services.set(
      ICommandService,
      makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]])),
    )
    services.set(IStorageService, makeStorageService())
    const input = new PerforceSyncHistoryEditorInput()
    const handled: boolean[] = []

    render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <ActivationFocusProbe input={input} onHandled={(ok) => handled.push(ok)}>
          <PerforceSyncHistoryEditor input={input} />
        </ActivationFocusProbe>
      </ServicesContext.Provider>,
    )

    // The listbox is on screen on the first render (loading is a row inside
    // it), so the activation focus must already find a registered target.
    expect(handled).toEqual([true])
    expect(document.activeElement).toBe(screen.getByRole('listbox'))

    // The first load resolves later and must not take focus away from the list.
    await flush()
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(1)
  })

  it('swaps the detail pane when another row is clicked', async () => {
    const first = makeRun({ id: 'run-1' })
    const second = makeRun({ id: 'run-2', spec: '@4521' })
    renderEditor(
      makeCommandService(
        makePage([first, second]),
        new Map([
          ['run-1', makeDetail(first)],
          ['run-2', makeDetail(second)],
        ]),
      ),
    )
    await flush()

    const rows = screen.getAllByTestId('perforce-sync-history-row')
    fireEvent.click(rows[1]!)
    // The click only moves the selection; the pane then fetches that run's
    // detail, so it needs its own settle.
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-target').textContent).toContain('@4521')
    expect(within(rows[1]!).getByTestId('perforce-sync-history-row-time')).toBeTruthy()
  })

  it('shows the delete-untracked flag, and hides the row for records that predate it', async () => {
    const withFlag = makeRun({ id: 'run-1', force: true, deleteUntracked: true })
    const legacy = makeRun({ id: 'run-2', force: true })
    renderEditor(
      makeCommandService(
        makePage([withFlag, legacy]),
        new Map([
          ['run-1', makeDetail(withFlag)],
          ['run-2', makeDetail(legacy)],
        ]),
      ),
    )
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-delete-untracked').textContent).toBe(
      'yes',
    )

    fireEvent.click(screen.getAllByTestId('perforce-sync-history-row')[1]!)
    await flush()
    // 旧记录的字段缺席 ≠ 「否」：整行不出现，而不是把“当时还没有这个能力”写成否定。
    expect(screen.queryByTestId('perforce-sync-history-detail-delete-untracked')).toBeNull()
  })

  it('renders a missing sampler as unavailable, never as zero bytes', async () => {
    // `exactOptionalPropertyTypes`: "no sampler" is an ABSENT key, so the record
    // is built by dropping it rather than by setting it to undefined.
    const sampled = makeRun({ id: 'run-2' })
    const { io: _sampler, ...other } = sampled
    const unsampled = { ...other, id: 'run-1' }
    renderEditor(
      makeCommandService(
        makePage([sampled, unsampled]),
        new Map([
          ['run-2', makeDetail(sampled)],
          ['run-1', makeDetail(unsampled)],
        ]),
      ),
    )
    await flush()

    const rows = screen.getAllByTestId('perforce-sync-history-row')
    fireEvent.click(rows[1]!)
    await flush()

    const read = screen.getByTestId('perforce-sync-history-detail-read').textContent ?? ''
    expect(read).toContain('unavailable')
    // The whole point: `0B` would claim the get moved nothing.
    expect(read).not.toContain('0B')
    expect(screen.getByTestId('perforce-sync-history-detail-write').textContent).not.toContain('0B')
  })

  it('shows the run’s p4 command count, and marks an old record as uncollected', async () => {
    const counted = makeRun({ id: 'run-2', p4Calls: { native: 1, p4delta: 2, complete: true } })
    // A record written before the field existed: the group is ABSENT, and the
    // pane has to say so rather than print a 0 the run never reported.
    const legacy = makeRun({ id: 'run-1' })
    renderEditor(
      makeCommandService(
        makePage([counted, legacy]),
        new Map([
          ['run-2', makeDetail(counted)],
          ['run-1', makeDetail(legacy)],
        ]),
      ),
    )
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-p4calls').textContent).toBe(
      '3 p4 command(s) (1 native · 2 δ)',
    )
    // The same total rides on the list row.
    const rows = screen.getAllByTestId('perforce-sync-history-row')
    expect(rows[0]!.textContent).toContain('3 p4 calls')

    fireEvent.click(rows[1]!)
    await flush()
    expect(screen.getByTestId('perforce-sync-history-detail-p4calls').textContent).toBe(
      'not collected (this record predates the field)',
    )
    // …and the row says nothing rather than claiming a count of 0.
    expect(rows[1]!.textContent).not.toContain('p4 calls')
  })

  it('states an incomplete p4 count as a lower bound, never as a total', async () => {
    const run = makeRun({ p4Calls: { native: 1, p4delta: 3, complete: false } })
    renderEditor(makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]])))
    await flush()

    const calls = screen.getByTestId('perforce-sync-history-detail-p4calls').textContent ?? ''
    expect(calls).toContain('≥4')
    expect(calls).toContain('not fully collected')
  })

  it('marks the disk-write count as a lower bound', async () => {
    const run = makeRun({ diskWrites: 3 })
    renderEditor(makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]])))
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-diskwrites').textContent).toBe(
      '≥3 file events',
    )
  })

  it('says δ does not use the parallel-thread knob instead of showing its number', async () => {
    const run = makeRun({ engine: 'p4delta', parallelThreads: 6 })
    renderEditor(makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]])))
    await flush()

    const threads = screen.getByTestId('perforce-sync-history-detail-threads').textContent ?? ''
    expect(threads).toContain('not used by δ')
    expect(threads).not.toContain('6')
  })

  it('shows the δ per-command breakdown, and says so when the engine reported none', async () => {
    const delta = makeRun({
      id: 'run-1',
      engine: 'p4delta',
      deltaRunId: 'p4d-1700000000000-4242-1-abcd1234',
      p4Calls: {
        native: 0,
        p4delta: 1078,
        complete: true,
        p4deltaByCommand: { ignores: 332, sync: 740, fstat: 3, set: 3 },
        p4deltaByCommandComplete: true,
      },
    })
    const plain = makeRun({
      id: 'run-2',
      p4Calls: { native: 1, p4delta: 0, complete: true },
    })
    renderEditor(
      makeCommandService(
        makePage([delta, plain]),
        new Map([
          ['run-1', makeDetail(delta)],
          ['run-2', makeDetail(plain)],
        ]),
      ),
    )
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-p4calls-bycommand').textContent).toBe(
      'sync 740 · ignores 332 · fstat 3 · set 3',
    )

    fireEvent.click(screen.getAllByTestId('perforce-sync-history-row')[1]!)
    await flush()

    // 未采集 ≠ 0：老引擎不报分类，这一行必须说出来而不是留空。
    expect(
      screen.getByTestId('perforce-sync-history-detail-p4calls-bycommand').textContent,
    ).toContain('not collected')
  })

  it('offers the p4delta log only for a run that has one, and opens it by record id', async () => {
    const withLog = makeRun({
      id: 'run-1',
      engine: 'p4delta',
      deltaRunId: 'p4d-1700000000000-4242-1-abcd1234',
    })
    const without = makeRun({ id: 'run-2', engine: 'p4' })
    const commands = makeCommandService(
      makePage([withLog, without]),
      new Map([
        ['run-1', makeDetail(withLog)],
        ['run-2', makeDetail(without)],
      ]),
    )
    renderEditor(commands)
    await flush()

    const button = screen.getByTestId('perforce-sync-history-detail-open-log')
    fireEvent.click(button)
    await flush()

    // 递的是记录 id：runId 由扩展从那条记录自己身上取，页面给不了路径。
    expect(commands.executeCommand).toHaveBeenCalledWith(
      PerforceSyncHistoryCommands.openLog,
      'run-1',
    )

    fireEvent.click(screen.getAllByTestId('perforce-sync-history-row')[1]!)
    await flush()

    // 纯原生的一次拉取没有 δ 日志可开，按钮就不该在（它会指向别人的日志）。
    expect(screen.queryByTestId('perforce-sync-history-detail-open-log')).toBeNull()
  })

  it('tells a failed run apart from one that never ran', async () => {
    // A clobber refusal, exactly as the e2e records one: p4 ran, exited 1, and
    // its summary is all zeroes. The engine facts ARE there (the client decorates
    // failures too), so the pane has to say "p4 did not report this" rather than
    // "nothing to transfer" / "this get never ran" — both of which would be false
    // about a run that was refused work.
    const failed = makeRun({
      id: 'run-1',
      outcome: 'failed',
      counts: {
        applied: 0,
        refusedModified: 0,
        refusedOverwrite: 0,
        keptOpen: 0,
        mustResolve: 0,
        handoff: 0,
      },
    })
    renderEditor(makeCommandService(makePage([failed]), new Map([['run-1', makeDetail(failed)]])))
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-files').textContent).toBe(
      'not reported by p4',
    )
    // The engine is a fact the failed run still has, and it must be shown.
    expect(screen.getByTestId('perforce-sync-history-detail-engine').textContent).toBe('p4')
  })

  it('describes a run that never executed without inventing its facts', async () => {
    // A declined gate: the record the extension writes when the user answered
    // "don't run it". Every fact that only a run could produce is ABSENT —
    // writing them out as undefined is what exactOptionalPropertyTypes forbids,
    // and what the extension itself does not do.
    const declined = {
      id: 'run-1',
      at: Date.now(),
      startedAt: Date.now(),
      durationMs: 0,
      clientRoot: ROOT,
      spec: '#head',
      force: false,
      trigger: 'explorer',
      outcome: 'declined',
      scopeNarrowed: false,
      scopeFirst: [{ path: `${ROOT}/src`, isDirectory: true }],
      scopeCount: 1,
    } satisfies P4SyncRunDto
    renderEditor(
      makeCommandService(makePage([declined]), new Map([['run-1', makeDetail(declined)]])),
    )
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-outcome').textContent).toBe('Not run')
    expect(screen.getByTestId('perforce-sync-history-detail-files').textContent).toBe(
      'this get never ran',
    )
    expect(screen.getByTestId('perforce-sync-history-detail-engine').textContent).toBe(
      'this get never ran',
    )
    // Nor are the run-only measurements blamed on the platform, the record's age
    // or the engine: there was no run to measure.
    for (const field of ['read', 'write', 'p4calls', 'p4calls-bycommand']) {
      expect(screen.getByTestId(`perforce-sync-history-detail-${field}`).textContent).toBe(
        'this get never ran',
      )
    }
  })

  it('says what the page is for when nothing has been recorded', async () => {
    renderEditor(makeCommandService(makePage([]), new Map()))
    await flush()

    const empty = screen.getByTestId('perforce-sync-history-empty')
    expect(empty.textContent).toContain('No sync runs recorded yet')
    // An empty history must not look like a still-loading one.
    expect(empty.textContent).not.toContain('Loading')
  })

  it('reports the extension as unavailable instead of an empty history', async () => {
    // The production shape of "no perforce extension in this install": the host's
    // command service RESOLVES `undefined` for an unregistered id, it does not
    // reject. A test that only mocks a rejection would miss the real path.
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => undefined),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService

    renderEditor(commands)
    await flush()

    // "You never synced anything" and "this install has no perforce extension"
    // are different statements; the page must not confuse them.
    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('perforce-sync-history-empty')).toBeNull()
  })

  it('treats a half-built page as unavailable rather than as an empty history', async () => {
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => ({ runs: 'not a list', total: 3 })),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService

    renderEditor(commands)
    await flush()

    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
  })

  it('lets the unavailable page retry, and does not claim the row list has focus', async () => {
    // The extension can come up after this tab did (a perforce workspace opened
    // later), so "unavailable" must not be a dead end — and while there is no
    // list, the editor input must not be told it can focus one.
    let available = false
    const run = makeRun()
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) => {
        if (!available) return undefined
        if (id === PerforceSyncHistoryCommands.getRuns) return makePage([run])
        if (id === PerforceSyncHistoryCommands.getRun) return makeDetail(run)
        return undefined
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService

    renderEditor(commands)
    await flush()
    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
    // Nothing to focus: a `focusRows` here would return true while focusing
    // nothing, swallowing the editor input's own fallback.
    expect(perforceSyncHistoryViewState.focusRows).toBeNull()

    available = true
    fireEvent.click(screen.getByTestId('perforce-sync-history-refresh'))
    await flush()

    expect(screen.queryByTestId('perforce-sync-history-unavailable')).toBeNull()
    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(1)
    expect(typeof perforceSyncHistoryViewState.focusRows).toBe('function')
  })

  it('reloads on refresh and re-registers the focus target', async () => {
    const run = makeRun()
    const commands = makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]]))
    renderEditor(commands)
    await flush()

    fireEvent.click(screen.getByTestId('perforce-sync-history-refresh'))
    await flush()

    // Counted per command id: a future refresh that also re-fetches the open
    // detail is a legitimate extra call, and a bare total would red on it for a
    // reason that has nothing to do with what this test is about.
    const callsOf = (id: string): number =>
      (commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === id)
        .length
    expect(callsOf(PerforceSyncHistoryCommands.getRuns)).toBe(2)
    // The input's focus() routes through this, so it has to be registered.
    expect(typeof perforceSyncHistoryViewState.focusRows).toBe('function')
    expect(typeof perforceSyncHistoryViewState.refresh).toBe('function')
  })

  it('states that a rotated-out record is gone', async () => {
    const run = makeRun()
    // The list row exists but the detail call answers `null`: the extension is
    // there and this history does not have that id (evicted between the page
    // load and the click).
    renderEditor(makeCommandService(makePage([run]), new Map()))
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-missing').textContent).toContain(
      'no longer in the history',
    )
  })

  it('does not read an absent extension as a rotated-out record', async () => {
    // The list answered, then the command disappeared (extension deactivated
    // between the two calls). `undefined` is "there is no perforce extension
    // here", which is a different statement from "this run was dropped".
    const run = makeRun()
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) =>
        id === PerforceSyncHistoryCommands.getRuns ? makePage([run]) : undefined,
      ),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService

    renderEditor(commands)
    await flush()

    expect(screen.getByTestId('perforce-sync-history-detail-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('perforce-sync-history-detail-missing')).toBeNull()
  })

  it('drops the previous run’s numbers the moment another row is selected', async () => {
    // The detail arrives asynchronously, so without a remount the pane keeps the
    // OLD run's counts and duration on screen under the NEW row's highlight.
    const first = makeRun({ id: 'run-1' })
    const second = makeRun({ id: 'run-2', spec: '@4521' })
    let release: (() => void) | undefined
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string, arg?: unknown) => {
        if (id === PerforceSyncHistoryCommands.getRuns) return makePage([first, second])
        if (String(arg) === 'run-1') return makeDetail(first)
        // run-2's detail is still in flight.
        return new Promise<P4SyncRunDetailDto>((resolve) => {
          release = () => resolve(makeDetail(second))
        })
      }),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService

    renderEditor(commands)
    await flush()
    expect(screen.getByTestId('perforce-sync-history-detail-target').textContent).toContain('#head')

    fireEvent.click(screen.getAllByTestId('perforce-sync-history-row')[1]!)
    await flush()

    expect(screen.queryByTestId('perforce-sync-history-detail-target')).toBeNull()
    expect(screen.getByTestId('perforce-sync-history-detail-loading')).toBeTruthy()

    release?.()
    await flush()
    expect(screen.getByTestId('perforce-sync-history-detail-target').textContent).toContain('@4521')
  })

  it('keeps the loaded page across an unmount', async () => {
    const run = makeRun()
    const commands = makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]]))
    const { unmount } = renderEditor(commands)
    await flush()
    unmount()

    renderEditor(commands)
    await flush()

    // One page load served both mounts: the store the module owns survived.
    const runCalls = (commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === PerforceSyncHistoryCommands.getRuns,
    )
    expect(runCalls).toHaveLength(1)
    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(1)
  })

  it('keeps the default selection when the first load lands after an unmount', async () => {
    // The tab was deactivated before the load settled. Nothing re-fetches on the
    // way back (the page is already `loaded`), so the selection has to have been
    // remembered by the load itself — otherwise the page returns with no
    // highlight and "Select a run", contradicting its own stored page.
    const run = makeRun()
    const commands = makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]]))
    const { unmount } = renderEditor(commands)
    unmount()
    await flush()
    expect(perforceSyncHistoryViewState.loaded).toBe(true)

    renderEditor(commands)
    await flush()

    expect(perforceSyncHistoryViewState.selectedId).toBe('run-1')
    expect(screen.queryByTestId('perforce-sync-history-no-selection')).toBeNull()
    expect(screen.getByTestId('perforce-sync-history-detail-target').textContent).toContain('#head')
  })

  it('presents refresh as a real button', async () => {
    renderEditor(makeCommandService(makePage([makeRun()]), new Map()))
    await flush()

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it('hands the CSV export to its action instead of exporting in the page', async () => {
    const commands = makeCommandService(makePage([makeRun()]), new Map())
    renderEditor(commands)
    await flush()

    fireEvent.click(screen.getByTestId('perforce-sync-history-export'))

    expect(commands.executeCommand).toHaveBeenCalledWith(ExportPerforceSyncHistoryAction.ID)
  })

  it('hides the CSV export while the extension is unavailable', async () => {
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => undefined),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService
    renderEditor(commands)
    await flush()

    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('perforce-sync-history-export')).toBeNull()
  })

  it('offers a sash between the list and the detail', async () => {
    renderEditor(makeCommandService(makePage([makeRun()]), new Map()))
    await flush()

    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('keeps the sash out of the unavailable page', async () => {
    const commands = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => undefined),
      onWillExecuteCommand: Event.None,
      onDidExecuteCommand: Event.None,
    } as unknown as ICommandService
    renderEditor(commands)
    await flush()

    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('applies a dragged sash width and persists it', async () => {
    const { storage } = renderEditor(makeCommandService(makePage([makeRun()]), new Map()))
    await flush()

    const sash = screen.getByRole('separator')
    fireEvent.mouseDown(sash, { clientX: 400 })
    // The sash installs its window listeners in an effect, so the drag has to
    // wait for a render round before it can move.
    await flush()
    fireEvent.mouseMove(window, { clientX: 460 })
    fireEvent.mouseUp(window)
    await flush()

    // happy-dom does no layout, so the drag starts from the fallback width —
    // which is why that constant exists and why 360 + 60 is a stable number.
    expect(storage.set).toHaveBeenCalledWith(
      'perforceSyncHistory.listWidth',
      420,
      StorageScope.GLOBAL,
    )
    expect(screen.getByTestId('perforce-sync-history-list-pane').getAttribute('style')).toContain(
      '420px',
    )
  })

  it('clamps a dragged width to the minimum', async () => {
    const { storage } = renderEditor(makeCommandService(makePage([makeRun()]), new Map()))
    await flush()

    const sash = screen.getByRole('separator')
    fireEvent.mouseDown(sash, { clientX: 400 })
    await flush()
    fireEvent.mouseMove(window, { clientX: -1000 })
    fireEvent.mouseUp(window)
    await flush()

    expect(storage.set).toHaveBeenCalledWith(
      'perforceSyncHistory.listWidth',
      200,
      StorageScope.GLOBAL,
    )
    expect(screen.getByTestId('perforce-sync-history-list-pane').getAttribute('style')).toContain(
      '200px',
    )
  })

  it('does not freeze the content-sized width when the sash is only clicked', async () => {
    const { storage } = renderEditor(makeCommandService(makePage([makeRun()]), new Map()))
    await flush()

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 400 })
    fireEvent.mouseUp(window)
    await flush()

    expect(storage.set).not.toHaveBeenCalled()
    expect(screen.getByTestId('perforce-sync-history-list-pane').getAttribute('style')).toBeNull()
  })

  it('restores the persisted width on mount', async () => {
    const storage = makeStorageService()
    ;(storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(420)
    renderEditor(makeCommandService(makePage([makeRun()]), new Map()), storage)
    await flush()

    expect(storage.get).toHaveBeenCalledWith('perforceSyncHistory.listWidth', StorageScope.GLOBAL)
    expect(screen.getByTestId('perforce-sync-history-list-pane').getAttribute('style')).toContain(
      '420px',
    )
  })
})

/** A command service whose `getRuns` answers from `pages` in order, repeating the
 *  last — for a page that gains a record while the tab is open. */
function makePagedCommandService(
  pages: readonly P4SyncHistoryLoadResult[],
  details: Map<string, P4SyncRunDetailDto>,
): ICommandService {
  let call = 0
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string, arg?: unknown) => {
      if (id === PerforceSyncHistoryCommands.getRuns) {
        const page = pages[Math.min(call++, pages.length - 1)] ?? pages[0]
        return page
      }
      if (id === PerforceSyncHistoryCommands.getRun) {
        return details.get(String(arg)) ?? null
      }
      return undefined
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService
}

/** A command service that holds every `getRuns` open until the test answers it,
 *  oldest first — the only way to place a poke inside a load that is still in
 *  flight. */
function makeHeldCommandService(details = new Map<string, P4SyncRunDetailDto>()): {
  readonly service: ICommandService
  readonly askedMax: number[]
  readonly pending: ((page: P4SyncHistoryLoadResult) => void)[]
} {
  const askedMax: number[] = []
  const pending: ((page: P4SyncHistoryLoadResult) => void)[] = []
  const service = {
    _serviceBrand: undefined,
    executeCommand: vi.fn((id: string, arg?: unknown) => {
      if (id === PerforceSyncHistoryCommands.getRuns) {
        askedMax.push((arg as { max?: number } | undefined)?.max ?? 0)
        return new Promise<P4SyncHistoryLoadResult>((resolve) => pending.push(resolve))
      }
      if (id === PerforceSyncHistoryCommands.getRun) {
        return Promise.resolve(details.get(String(arg)) ?? null)
      }
      return Promise.resolve(undefined)
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService
  return { service, askedMax, pending }
}

/** The debounce runs on real timers here (fake ones would break `flush`'s
 *  macrotask rounds), so a poke-driven reload needs a real wait. */
const waitForPoke = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, SYNC_HISTORY_POKE_DEBOUNCE_MS + 50))

describe('a record landing while the tab is open', () => {
  it('reloads the list on the poke, without moving the selection', async () => {
    const older = makeRun({ id: 'run-1' })
    const newer = makeRun({ id: 'run-2', at: Date.now() })
    const commands = makePagedCommandService(
      [makePage([older], 1), makePage([newer, older], 2)],
      new Map([
        ['run-1', makeDetail(older)],
        ['run-2', makeDetail(newer)],
      ]),
    )
    renderEditor(commands)
    await flush()
    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(1)
    expect(perforceSyncHistoryViewState.selectedId).toBe('run-1')

    noteSyncHistoryRecorded()
    await waitForPoke()
    await flush()

    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(2)
    // The row the user was reading keeps the highlight: a new run landing is not
    // a reason to move them.
    expect(perforceSyncHistoryViewState.selectedId).toBe('run-1')
    expect(perforceSyncHistoryViewState.stale).toBe(false)
  })

  it('marks an unmounted page stale, and re-reads once on the way back', async () => {
    const older = makeRun({ id: 'run-1' })
    const newer = makeRun({ id: 'run-2', at: Date.now() })
    const commands = makePagedCommandService(
      [makePage([older], 1), makePage([newer, older], 2)],
      new Map([
        ['run-1', makeDetail(older)],
        ['run-2', makeDetail(newer)],
      ]),
    )
    const { unmount } = renderEditor(commands)
    await flush()
    unmount()

    noteSyncHistoryRecorded()
    await waitForPoke()

    // Nothing to reload into — the record is remembered instead.
    expect(perforceSyncHistoryViewState.stale).toBe(true)
    expect(
      (commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === PerforceSyncHistoryCommands.getRuns,
      ),
    ).toHaveLength(1)

    renderEditor(commands)
    await flush()

    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(2)
    expect(perforceSyncHistoryViewState.stale).toBe(false)
  })

  it('keeps the size the user asked for when the poke lands mid-Load more', async () => {
    const held = makeHeldCommandService()
    renderEditor(held.service)
    // The mount load, answered so the page is on screen with a "Load more".
    const first = makeRun({ id: 'run-1' })
    held.pending[0]?.(makePage([first], 60, true))
    await flush()

    fireEvent.click(screen.getByTestId('perforce-sync-history-load-more'))
    // A record lands while that larger page is still in flight.
    noteSyncHistoryRecorded()
    // Polled, not slept-then-asserted: the debounce runs on real timers here, and
    // a loaded machine must not turn a late dispatch into a failure.
    await vi.waitFor(() => expect(held.askedMax).toHaveLength(3))

    // The reload asks for what the user asked for — a stale `limit` here would
    // quietly drop the page back to 50 rows.
    expect(held.askedMax).toEqual([50, 100, 100])
    expect(perforceSyncHistoryViewState.limit).toBe(100)

    // The poked reload answers first and is the one that may write; the held
    // Load more settling afterwards must not shrink the page it asked for.
    held.pending[2]?.(makePage([first], 60, true))
    held.pending[1]?.(makePage([first], 1, false))
    await flush()

    expect(perforceSyncHistoryViewState.total).toBe(60)
    expect(screen.getByTestId('perforce-sync-history-count').textContent).toBe('60 run(s)')
  })

  it('lets the newer dispatch write when two loads settle out of order', async () => {
    const held = makeHeldCommandService()
    renderEditor(held.service)
    await flush()

    // The poke's reload is dispatched second and answers first.
    noteSyncHistoryRecorded()
    await vi.waitFor(() => expect(held.pending).toHaveLength(2))

    const newer = makeRun({ id: 'run-newer', spec: '@5000' })
    const older = makeRun({ id: 'run-older', spec: '@4000' })
    held.pending[1]?.(makePage([newer], 1))
    await flush()
    held.pending[0]?.(makePage([older], 1))
    await flush()

    // The late answer of the older dispatch is dropped rather than painted over
    // the newer one.
    expect(screen.getAllByTestId('perforce-sync-history-row')).toHaveLength(1)
    expect(screen.getByTestId('perforce-sync-history-row').textContent).toContain('changelist 5000')
    expect(perforceSyncHistoryViewState.runs.map((r) => r.id)).toEqual(['run-newer'])
  })

  it('answers a poke on the unavailable page by retrying, not by inventing history', async () => {
    const commands = makeCommandService({} as P4SyncHistoryLoadResult, new Map())
    ;(commands.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    renderEditor(commands)
    await flush()
    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()

    noteSyncHistoryRecorded()
    await waitForPoke()
    await flush()

    // Asked again (the extension may have come up since), and still honest about
    // not having an answer.
    expect(
      (commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === PerforceSyncHistoryCommands.getRuns,
      ),
    ).toHaveLength(2)
    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
  })

  it('stays stale when the poked reload fails, and re-reads on the way back', async () => {
    const run = makeRun()
    const commands = makeCommandService(makePage([run]), new Map([['run-1', makeDetail(run)]]))
    const getRunsCalls = (): unknown[][] =>
      (commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === PerforceSyncHistoryCommands.getRuns,
      )
    const { unmount } = renderEditor(commands)
    await flush()
    expect(getRunsCalls()).toHaveLength(1)

    // The extension is gone by the time the poke's reload asks — a host restart,
    // which is exactly when the records it announced have not been seen yet.
    ;(commands.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    noteSyncHistoryRecorded()
    await vi.waitFor(() => expect(getRunsCalls()).toHaveLength(2))
    await flush()

    expect(screen.getByTestId('perforce-sync-history-unavailable')).toBeTruthy()
    // A failed reload must NOT clear the flag: the page still is not current, and
    // the next mount has to try again rather than show the page it left.
    expect(perforceSyncHistoryViewState.stale).toBe(true)

    unmount()
    renderEditor(commands)
    await flush()

    expect(getRunsCalls()).toHaveLength(3)
  })
})
