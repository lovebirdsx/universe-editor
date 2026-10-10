/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Sync History page: it loads the run list over the
 *  extension commands, keeps the selection in step with the list, and — the part
 *  worth a test — never renders a missing measurement as a zero. The three
 *  degradation rules (no records / no sampler / no δ thread count) are asserted
 *  exactly as the wire contract states them.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  ICommandService,
  InstantiationService,
  ServiceCollection,
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
  perforceSyncHistoryViewState,
} from '../../../services/perforceSyncHistory/syncHistoryViewState.js'
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

function renderEditor(commandService: ICommandService) {
  const services = new ServiceCollection()
  services.set(ICommandService, commandService)
  const utils = render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceSyncHistoryEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
  return utils
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
})
