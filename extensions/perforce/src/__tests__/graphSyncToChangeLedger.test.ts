/**
 * Command-layer gate tests for the graph's direct sync-point bookkeeping: drive
 * the real `perforce-graph.syncToChange` handler captured from `activate()` with
 * a real `GraphSyncLedger` under a temp `globalStoragePath`, and count the
 * sync-point read-back the handler either pays or skips.
 *
 * The claim is only ever established from the LISTING's scope the renderer
 * echoed back, so these lock in both directions:
 *  1. A row menu's get (get scope === listing scope) records the row's
 *     changelist with ZERO p4 read-back calls.
 *  2. The multi-directory dialog (narrower picked scope, wider listing) still
 *     asks p4 and records p4's answer, never the row's changelist.
 *  3. A refused get still records — with `complete: false`, the honest upper
 *     bound — and a clobber failure records nothing at all.
 *  4. Every way the claim can be unusable (no listing scope, an empty one, a
 *     whole-repo listing, another client, a stale or missing client echo) falls
 *     back to the read-back silently, with no error toast: this is bookkeeping,
 *     never a reason to fail a get.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { SyncLedgerRecord } from '../graphSyncLedger.js'

const ROOT = vi.hoisted(() => 'X:/p4ws/main')
const SRC = `${ROOT}/src`

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
  showWarningMessage: vi.fn(async () => undefined as string | undefined),
  showErrorMessage: vi.fn(async () => undefined as string | undefined),
  showQuickPick: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined as string | undefined),
  withProgress: vi.fn(
    async (_opts: unknown, fn: (progress: unknown, token: unknown) => Promise<unknown>) =>
      fn({ report: vi.fn() }, { onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) }),
  ),
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
  status: { syncProgress?: unknown }
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
  fake.status = {}
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
  // The read-back is the thing under test: every assertion about it is a call
  // count, so its answer stays deliberately DIFFERENT from the row's id — an
  // implementation that records the row on the read-back path would pass while
  // reading back.
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

const CONFIRM_SYNC = localize('perforce.btn.confirmSync', 'Confirm Sync')

let fake: FakeClient
let storage: string

function ledgerRecords(): SyncLedgerRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(storage, 'graphSyncLedger.json'), 'utf8')) as {
      records?: SyncLedgerRecord[]
    }
    return raw.records ?? []
  } catch {
    // No file yet — no get has recorded anything, which several tests assert.
    return []
  }
}

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
  const handler = commandsMock.handlers.get(id)
  expect(handler, `command ${id} registered`).toBeDefined()
  await handler!(...args)
}

const syncToChange = (...args: unknown[]) => runCommand('perforce-graph.syncToChange', ...args)

beforeEach(async () => {
  fake = makeFakeClient()
  clientMock.state.current = fake
  storage = mkTempDir('p4-direct-')
  commandsMock.handlers.clear()
  commandsMock.executeCommand.mockClear()
  windowMock.showInformationMessage.mockClear()
  windowMock.showWarningMessage.mockClear()
  windowMock.showErrorMessage.mockClear()
  // The time-travel warning would otherwise answer `undefined` (dismissed) and
  // stop every get below before it runs; saying yes here stands for the user's
  // own confirmation, whose wording is asserted in the graph sync tests.
  windowMock.showWarningMessage.mockResolvedValue(CONFIRM_SYNC)
  await activate({ subscriptions: [], globalStoragePath: storage } as never)
  expect(clientMock.create).toHaveBeenCalled()
})

describe('perforce-graph.syncToChange direct bookkeeping', () => {
  it('records the row changelist without a read-back when the get covers the listing', async () => {
    await syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    expect(fake.readGraphSyncPoint).not.toHaveBeenCalled()
    const records = ledgerRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      change: '4522',
      source: 'sync',
      complete: true,
      floor: 4522,
      clientRoot: ROOT,
      paths: [{ path: ROOT, isDirectory: true }],
    })
  })

  it('accepts a claim whose get is wider than the listing', async () => {
    // The row menu on a scoped tab passes the same scope twice; a get that
    // covers MORE than the listing is the whole-repo variant of the same proof.
    await syncToChange({
      change: '4522',
      scopePaths: [{ path: ROOT, isDirectory: true }],
      listScope: { scopePaths: [{ path: SRC, isDirectory: true }] },
      clientRoot: ROOT,
    })
    expect(fake.readGraphSyncPoint).not.toHaveBeenCalled()
    expect(ledgerRecords()[0]).toMatchObject({ change: '4522', complete: true })
  })

  it('falls back to the read-back for the dialog, whose picked scope is narrower', async () => {
    await syncToChange({
      change: '4522',
      scopePaths: [{ path: SRC, isDirectory: true }],
      listScope: { wholeRepo: false },
      clientRoot: ROOT,
    })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    const records = ledgerRecords()
    expect(records).toHaveLength(1)
    // p4's answer, not the row's changelist: that row may never have touched the
    // picked directory.
    expect(records[0]).toMatchObject({ change: '4521' })
  })

  it('records a refused get too, labelled as an upper bound', async () => {
    fake.sync.mockResolvedValue({
      ok: true,
      cancelled: false,
      summary: {
        applied: 1,
        keptOpen: 0,
        mustResolve: 0,
        refusedModified: 2,
        refusedOverwrite: 0,
        upToDate: false,
      },
      refusedFiles: [],
      refusedOverwriteFiles: [],
      error: undefined,
    })
    await syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    expect(fake.readGraphSyncPoint).not.toHaveBeenCalled()
    const records = ledgerRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ change: '4522', source: 'sync', complete: false })
  })

  it('records nothing when the get itself failed', async () => {
    fake.sync.mockResolvedValue({
      ok: false,
      cancelled: false,
      summary: undefined,
      refusedFiles: [],
      refusedOverwriteFiles: [],
      error: { kind: 'clobber', suggestion: 'x' },
    })
    await syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    expect(fake.readGraphSyncPoint).not.toHaveBeenCalled()
    expect(ledgerRecords()).toHaveLength(0)
  })

  it('refuses a listing from another client and asks p4 instead', async () => {
    await syncToChange({
      change: '4522',
      scopePaths: [{ path: ROOT, isDirectory: true }],
      // A listing that belongs to a different workspace: its rows' changelists
      // say nothing about this get's scope.
      listScope: { scopePaths: [{ path: 'X:/elsewhere', isDirectory: true }] },
      clientRoot: ROOT,
    })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()[0]).toMatchObject({ change: '4521' })
  })

  it('refuses rows whose echoed client is stale', async () => {
    await syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: 'X:/old' })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()[0]).toMatchObject({ change: '4521' })
  })

  it('refuses rows whose client was never echoed back', async () => {
    // Without the echo there is no way to tell WHICH client's rows these are: the
    // listing and the get both resolve against the graph's current client, so a
    // client switch would compare the stale row against the new client's scope
    // and agree with itself.
    await syncToChange({ change: '4522', listScope: { wholeRepo: false } })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()[0]).toMatchObject({ change: '4521' })
  })

  it('refuses a whole-repo listing and asks p4 instead', async () => {
    // `//...` lists depot-wide, while every ledger coordinate is a host path
    // under the client root — so the coverage test would compare the client root
    // against itself and prove nothing about a changelist that only touched an
    // AltRoots path. The get still runs; only the shortcut is given up.
    await syncToChange({
      change: '4522',
      wholeRepo: true,
      listScope: { wholeRepo: true },
      clientRoot: ROOT,
    })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()[0]).toMatchObject({ change: '4521' })
  })

  it('falls back silently when the request carries no listing scope at all', async () => {
    await syncToChange({ change: '4522' })
    expect(fake.readGraphSyncPoint).toHaveBeenCalledTimes(1)
    expect(ledgerRecords()[0]).toMatchObject({ change: '4521' })
    // Nothing claimed anything, so nothing is reported: bookkeeping never
    // becomes an error the user has to read.
    expect(windowMock.showErrorMessage).not.toHaveBeenCalled()
  })

  it('keeps an entry that an unusable claim cannot be replaced by', async () => {
    // Both entries are for the same scope; the second get carries a claim whose
    // listing is from another client. The read-back still answers, so the badge
    // moves — just through p4 rather than through the claim.
    await syncToChange({ change: '4522', listScope: { wholeRepo: false }, clientRoot: ROOT })
    fake.readGraphSyncPoint.mockResolvedValue({ id: '4530', failed: false, timedOut: false })
    await syncToChange({
      change: '4529',
      scopePaths: [{ path: ROOT, isDirectory: true }],
      listScope: { scopePaths: [{ path: 'X:/elsewhere', isDirectory: true }] },
      clientRoot: ROOT,
    })
    const records = ledgerRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ change: '4530' })
  })
})
