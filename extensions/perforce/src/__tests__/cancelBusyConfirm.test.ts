/**
 * Command-layer tests for the confirmation that now guards stopping in-flight
 * p4 work. Both entries — the status bar's spinner click and the sync
 * notification's cancel button — route through one helper in `activate`, so
 * these drive the real handlers captured from `activate()` and assert on the
 * fake client rather than on the status bar's rendering.
 *
 * The three claims worth locking in:
 *  1. Stopping happens ONLY on an explicit confirmation; dismissing the dialog
 *     leaves the run alone (`Esc` must be a safe answer).
 *  2. The dialog is an async gap: if the run it asked about has finished and
 *     something else started (the collect after a get registers a cancellable
 *     source of its own), a stale "yes" must not kill work the user never saw.
 *  3. Declining the notification's cancel leaves the get running to completion —
 *     the progress token is flipped and one-way, but the get's outcome is
 *     decided by whether the p4 child was killed, and it wasn't.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { SyncLedgerRecord } from '../graphSyncLedger.js'

const ROOT = vi.hoisted(() => 'X:/p4ws/main')

const progressMock = vi.hoisted(() => {
  const state = { tokenCancel: undefined as (() => void) | undefined }
  return {
    state,
    withProgress: vi.fn(
      async (_opts: unknown, fn: (progress: unknown, token: unknown) => Promise<unknown>) =>
        fn(
          { report: vi.fn() },
          {
            onCancellationRequested: (cb: () => void) => {
              state.tokenCancel = cb
              return { dispose: vi.fn() }
            },
          },
        ),
    ),
  }
})

const commandsMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler)
      return { dispose: vi.fn() }
    }),
    executeCommand: vi.fn(async () => undefined),
  }
})

const windowMock = vi.hoisted(() => ({
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn() })),
  showInformationMessage: vi.fn(async () => undefined as string | undefined),
  // Typed like the API it stands in for: the confirmation's assertions read the
  // offered button back off `calls`, which needs the tuple to carry the varargs.
  showWarningMessage: vi.fn(async (..._args: string[]): Promise<string | undefined> => undefined),
  showErrorMessage: vi.fn(async () => undefined as string | undefined),
  showQuickPick: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined as string | undefined),
  withProgress: progressMock.withProgress,
}))

const workspaceMock = vi.hoisted(() => {
  const get = vi.fn(async (_key: string, def: unknown) => def)
  return {
    rootPath: ROOT,
    getConfiguration: vi.fn(() => ({ get })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    registerTimelineProvider: vi.fn(() => ({ dispose: vi.fn() })),
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  commands: commandsMock,
  window: windowMock,
  workspace: workspaceMock,
  ProgressLocation: { Notification: 15 },
}))

type Mock = ReturnType<typeof vi.fn>

interface FakeClient {
  root: string
  clientName: string
  user: string
  syncScopeDirs: readonly string[]
  syncScopes: readonly string[]
  status: { busy?: string; syncProgress?: unknown }
  cancellableEpoch: number | undefined
  sync: Mock
  readGraphSyncPoint: Mock
  notifyScmStateChanged: Mock
  refresh: Mock
  startPolling: Mock
  setSwarmAvailable: Mock
  setReconcileScope: Mock
  setReconcileScanOptions: Mock
  setReconcileLimit: Mock
  setOpenedByOthersOptions: Mock
  setSyncParallelThreads: Mock
  setSyncScope: Mock
  setReconcileExcludes: Mock
  dispose: Mock
  cancelBusy: Mock
  reconcile: Mock
}

/** Only what this file's commands touch; everything else is a no-op stub so
 *  `activate` can wire the rest of the extension without a real client. */
function makeFakeClient(): FakeClient {
  const fake = {} as FakeClient
  fake.root = ROOT
  fake.clientName = 'testclient'
  fake.user = 'testuser'
  fake.syncScopeDirs = []
  fake.syncScopes = [`${ROOT}/...`]
  fake.status = { busy: 'Syncing' }
  // Stands in for the abort source a real run registers while it is in flight.
  fake.cancellableEpoch = 1
  fake.sync = vi.fn(async () => ({
    ok: true,
    cancelled: false,
    summary: {
      applied: 3,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      upToDate: false,
    },
    refusedFiles: [],
    refusedOverwriteFiles: [],
    error: undefined,
  }))
  fake.readGraphSyncPoint = vi.fn(async () => ({ id: '4521', failed: false, timedOut: false }))
  fake.notifyScmStateChanged = vi.fn()
  fake.refresh = vi.fn(async () => {})
  fake.startPolling = vi.fn()
  fake.setSwarmAvailable = vi.fn()
  fake.setReconcileScope = vi.fn()
  fake.setReconcileScanOptions = vi.fn()
  fake.setReconcileLimit = vi.fn()
  fake.setOpenedByOthersOptions = vi.fn()
  fake.setSyncParallelThreads = vi.fn()
  fake.setSyncScope = vi.fn()
  fake.setReconcileExcludes = vi.fn()
  fake.dispose = vi.fn()
  fake.cancelBusy = vi.fn()
  fake.reconcile = vi.fn(async () => {})
  return fake
}

const clientMock = vi.hoisted(() => {
  const state = { current: undefined as unknown }
  return {
    state,
    create: vi.fn(async () => state.current),
    createForClient: vi.fn(async () => state.current),
  }
})
vi.mock('../client.js', () => ({
  PerforceClient: class {
    static create = clientMock.create
    static createForClient = clientMock.createForClient
  },
  SYNC_POINT_READBACK_SLOW_EXEC: { priority: 'background', timeoutMs: 60_000 },
}))

vi.mock('../timelineProvider.js', () => ({
  PerforceTimelineProvider: class {
    trackClient = () => ({ dispose: vi.fn() })
  },
  createPerforceTimelineCommands: vi.fn(() => []),
}))
vi.mock('../p4StatusBar.js', () => ({
  P4StatusBarController: class {
    refresh = vi.fn()
  },
}))
vi.mock('../autoEdit.js', () => ({
  AutoEditController: class {
    start = vi.fn(async () => {})
  },
}))
vi.mock('../swarm/swarmCommands.js', () => ({
  registerSwarmCommands: vi.fn(() => ({ dispose: vi.fn() })),
}))

import { activate } from '../extension.js'
import { localize } from '../nls.js'

const BTN_STOP = localize('perforce.btn.stopOperation', 'Stop Operation')
const CONFIRM_STOP = localize(
  'perforce.cancelBusy.confirm',
  '{0} — stop it? Work already done is kept and anything unfinished is left as it is; any other p4 operation in this workspace is stopped too.',
  { 0: 'Syncing' },
)
const CONFIRM_SYNC = localize('perforce.btn.confirmSync', 'Confirm Sync')

const SYNC_OK = {
  ok: true,
  cancelled: false,
  summary: {
    applied: 3,
    keptOpen: 0,
    mustResolve: 0,
    refusedModified: 0,
    refusedOverwrite: 0,
    upToDate: false,
  },
  refusedFiles: [],
  refusedOverwriteFiles: [],
  error: undefined,
}

const SYNC_CANCELLED = { ...SYNC_OK, ok: false, cancelled: true }

let fake: FakeClient
let storage: string

function ledgerRecords(): SyncLedgerRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(storage, 'graphSyncLedger.json'), 'utf8')) as {
      records?: SyncLedgerRecord[]
    }
    return raw.records ?? []
  } catch {
    // No file yet — no get has recorded anything, which the declined-cancel
    // test's sibling asserts.
    return []
  }
}

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
  const handler = commandsMock.handlers.get(id)
  expect(handler, `command ${id} registered`).toBeDefined()
  await handler!(...args)
}

/** The status-bar entry's click, which carries no argument. */
const clickStatusBar = () => runCommand('perforce.cancelBusy')

const syncToChange = (...args: unknown[]) => runCommand('perforce-graph.syncToChange', ...args)

/** Calls made to the stop-confirmation dialog, told apart from the graph sync's
 *  own time-travel confirmation by the button it offers. */
const stopConfirmCalls = (): unknown[][] =>
  windowMock.showWarningMessage.mock.calls.filter((c) => c[1] === BTN_STOP)

beforeEach(async () => {
  fake = makeFakeClient()
  clientMock.state.current = fake
  storage = mkTempDir('p4-cancel-')
  commandsMock.handlers.clear()
  commandsMock.executeCommand.mockClear()
  windowMock.showInformationMessage.mockClear()
  windowMock.showWarningMessage.mockClear()
  windowMock.showWarningMessage.mockResolvedValue(undefined)
  windowMock.showErrorMessage.mockClear()
  progressMock.state.tokenCancel = undefined
  progressMock.withProgress.mockClear()
  await activate({ subscriptions: [], globalStoragePath: storage } as never)
  expect(clientMock.create).toHaveBeenCalled()
})

describe('stopping in-flight p4 work', () => {
  it('stops the run once the user confirms', async () => {
    windowMock.showWarningMessage.mockResolvedValue(BTN_STOP)

    await clickStatusBar()

    expect(windowMock.showWarningMessage).toHaveBeenCalledWith(CONFIRM_STOP, BTN_STOP)
    expect(fake.cancelBusy).toHaveBeenCalledTimes(1)
  })

  it('leaves the run alone when the dialog is dismissed', async () => {
    windowMock.showWarningMessage.mockResolvedValue(undefined)

    await clickStatusBar()

    expect(windowMock.showWarningMessage).toHaveBeenCalledTimes(1)
    expect(fake.cancelBusy).not.toHaveBeenCalled()
  })

  it('does not ask when nothing cancellable is in flight', async () => {
    fake.cancellableEpoch = undefined

    await clickStatusBar()

    expect(windowMock.showWarningMessage).not.toHaveBeenCalled()
    expect(fake.cancelBusy).not.toHaveBeenCalled()
  })

  it('does not stop work that started while the dialog was up', async () => {
    // The run the user was asked about finished, and the client's own follow-up
    // (the collect after a get) registered a source of its own. Confirming now
    // would kill that instead — work the user never saw.
    windowMock.showWarningMessage.mockImplementation(async () => {
      fake.cancellableEpoch = 2
      return BTN_STOP
    })

    await clickStatusBar()

    expect(fake.cancelBusy).not.toHaveBeenCalled()
  })

  it('asks only once when the entry is clicked twice before the dialog mounts', async () => {
    let answer!: (value: string | undefined) => void
    windowMock.showWarningMessage.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          answer = resolve
        }),
    )

    const first = clickStatusBar()
    const second = clickStatusBar()
    await vi.waitFor(() => expect(stopConfirmCalls()).toHaveLength(1))
    answer(BTN_STOP)
    await Promise.all([first, second])

    expect(stopConfirmCalls()).toHaveLength(1)
    expect(fake.cancelBusy).toHaveBeenCalledTimes(1)
  })

  it('lets the get run to completion when the notification cancel is declined', async () => {
    windowMock.showWarningMessage.mockImplementation(
      async (_message: string, ...items: string[]): Promise<string | undefined> =>
        items.includes(BTN_STOP) ? undefined : CONFIRM_SYNC,
    )
    let finishSync!: (value: unknown) => void
    fake.sync = vi.fn(
      () =>
        new Promise((resolve) => {
          finishSync = resolve
        }),
    )

    const get = syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    await vi.waitFor(() => expect(progressMock.state.tokenCancel).toBeDefined())

    progressMock.state.tokenCancel!()
    await vi.waitFor(() => expect(stopConfirmCalls()).toHaveLength(1))
    expect(fake.cancelBusy).not.toHaveBeenCalled()

    finishSync(SYNC_OK)
    await get

    // The ledger entry is the proof the get ran its normal course: a cancelled
    // result returns from `runSync` before bookkeeping, so an empty ledger would
    // mean the declined confirmation had killed it after all.
    expect(ledgerRecords()).toHaveLength(1)
  })

  it('stops the get when the notification cancel is confirmed', async () => {
    windowMock.showWarningMessage.mockImplementation(
      async (_message: string, ...items: string[]): Promise<string | undefined> =>
        items.includes(BTN_STOP) ? BTN_STOP : CONFIRM_SYNC,
    )
    let finishSync!: (value: unknown) => void
    fake.sync = vi.fn(
      () =>
        new Promise((resolve) => {
          finishSync = resolve
        }),
    )
    fake.cancelBusy.mockImplementation(() => finishSync(SYNC_CANCELLED))

    const get = syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    await vi.waitFor(() => expect(progressMock.state.tokenCancel).toBeDefined())

    progressMock.state.tokenCancel!()
    await get

    expect(fake.cancelBusy).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()).toHaveLength(0)
  })
})
