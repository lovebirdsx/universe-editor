/**
 * Command-layer tests for the sync points a tool OUTSIDE this editor recorded:
 * drive the real `perforce-graph.getSyncPoint` handler captured from `activate()`
 * with a real `GraphSyncLedger` under a temp `globalStoragePath` and a real
 * `ExternalSyncPoints` over temp record files.
 *
 * The claims locked in here are the ones only the wiring can break:
 *  1. An external record reaches the renderer through the wire as
 *     `source: 'external'` — the tooltip's wording depends on it, and a source
 *     that silently degrades to `'sync'` would claim the editor pulled it.
 *  2. The editor's own newer record still wins.
 *  3. Nothing read from those files is ever written to the ledger.
 *  4. UGS's state file is looked up inside the workspace being asked about.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { P4GraphSyncPoint } from '@universe-editor/extensions-common'
import { SAVIOR_CONFIG_ENV } from '../graphSyncExternal.js'

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
    rootPath: 'X:/p4ws/main',
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

/** Only what `activate` and the sync-point command touch; the rest are no-op
 *  stubs so the extension wires itself without a real client. */
function makeFakeClient(root: string) {
  const get = vi.fn(async (_key: string, def: unknown) => def)
  return {
    root,
    clientName: 'testclient',
    user: 'testuser',
    syncScopeDirs: [] as readonly string[],
    syncScopes: [`${root}/...`],
    status: {},
    sync: vi.fn(),
    readGraphSyncPoint: vi.fn(),
    notifyScmStateChanged: vi.fn(),
    refresh: vi.fn(async () => {}),
    startPolling: vi.fn(),
    setSwarmAvailable: vi.fn(),
    setReconcileScope: vi.fn(),
    setReconcileScanOptions: vi.fn(),
    setReconcileLimit: vi.fn(),
    setOpenedByOthersOptions: vi.fn(),
    setSyncParallelThreads: vi.fn(),
    setSyncScope: vi.fn(),
    setReconcileExcludes: vi.fn(),
    dispose: vi.fn(),
    cancelBusy: vi.fn(),
    reconcile: vi.fn(async () => {}),
    runReconcileScan: vi.fn(),
    getConfiguration: vi.fn(() => ({ get })),
  }
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

let dir: string
let storage: string
let clientRoot: string
let saviorFile: string | undefined
let ledgerSeed: unknown

/** Point the savior env at `records`, or at a file that is not there. The
 *  variable is ALWAYS set: leaving it unset falls back to the savior file under
 *  the developer's own home, i.e. to whatever that machine happens to hold. */
async function start(records: Record<string, unknown> | undefined): Promise<void> {
  saviorFile = join(dir, records === undefined ? 'absent.json' : 'sync_config.json')
  if (records !== undefined) {
    writeFileSync(saviorFile, JSON.stringify(records), 'utf8')
  }
  process.env[SAVIOR_CONFIG_ENV] = saviorFile
  if (ledgerSeed !== undefined) {
    writeFileSync(join(storage, 'graphSyncLedger.json'), JSON.stringify(ledgerSeed), 'utf8')
  }
  workspaceMock.rootPath = clientRoot
  clientMock.state.current = makeFakeClient(clientRoot)
  await activate({ subscriptions: [], globalStoragePath: storage } as never)
}

function syncPoint(opts: unknown = {}): P4GraphSyncPoint | null {
  const handler = commandsMock.handlers.get('perforce-graph.getSyncPoint')
  expect(handler, 'perforce-graph.getSyncPoint registered').toBeDefined()
  return handler!(opts) as P4GraphSyncPoint | null
}

function ledgerText(): string {
  try {
    return readFileSync(join(storage, 'graphSyncLedger.json'), 'utf8')
  } catch {
    return ''
  }
}

/** One `editor_savior` entry for the workspace under test. */
function saviorEntry(change: number, timestamp: number): Record<string, unknown> {
  return {
    '//depot/branch_x': [
      { ClientName: 'testclient', ClientRoot: clientRoot, ChangeNum: change, Timestamp: timestamp },
    ],
  }
}

beforeEach(() => {
  dir = mkTempDir('p4-external-cmd-')
  storage = mkTempDir('p4-external-store-')
  clientRoot = join(dir, 'ws')
  mkdirSync(clientRoot, { recursive: true })
  saviorFile = undefined
  ledgerSeed = undefined
  commandsMock.handlers.clear()
})

afterEach(() => {
  delete process.env[SAVIOR_CONFIG_ENV]
})

describe('perforce-graph.getSyncPoint with records from outside the editor', () => {
  it('answers from the savior file, labelled as recorded outside the editor', async () => {
    await start(saviorEntry(4522, 1000))
    expect(syncPoint()).toEqual({
      id: '4522',
      source: 'external',
      at: 1000,
      widerScope: false,
      partial: false,
    })
  })

  it('labels a subdirectory scope as an upper bound', async () => {
    await start(saviorEntry(4522, 1000))
    const scoped = syncPoint({ scopePaths: [{ path: join(clientRoot, 'src'), isDirectory: true }] })
    expect(scoped).toMatchObject({ id: '4522', source: 'external', widerScope: true })
  })

  it('answers from the workspace’s own UGS state file', async () => {
    await start(undefined)
    mkdirSync(join(clientRoot, '.ugs'), { recursive: true })
    writeFileSync(
      join(clientRoot, '.ugs', 'state.json'),
      JSON.stringify({ CurrentChangeNumber: 4522, LastSyncTime: '2020-09-18T09:35:18.000Z' }),
      'utf8',
    )
    expect(syncPoint()).toMatchObject({
      id: '4522',
      source: 'external',
      at: Date.parse('2020-09-18T09:35:18.000Z'),
    })
  })

  it('keeps the editor’s own answer when it is the newer of the two', async () => {
    ledgerSeed = {
      version: 1,
      records: [
        {
          clientRoot,
          paths: [{ path: clientRoot, isDirectory: true }],
          change: '4560',
          source: 'sync',
          at: 2000,
          complete: true,
        },
      ],
    }
    await start(saviorEntry(4522, 1000))
    expect(syncPoint()).toMatchObject({ id: '4560', source: 'sync' })
  })

  it('takes the newer external record over an older one of the editor’s', async () => {
    ledgerSeed = {
      version: 1,
      records: [
        {
          clientRoot,
          paths: [{ path: clientRoot, isDirectory: true }],
          change: '4520',
          source: 'sync',
          at: 1000,
          complete: true,
        },
      ],
    }
    await start(saviorEntry(4522, 2000))
    expect(syncPoint()).toMatchObject({ id: '4522', source: 'external' })
  })

  it('never writes what it read into the ledger', async () => {
    ledgerSeed = {
      version: 1,
      records: [
        {
          clientRoot,
          paths: [{ path: clientRoot, isDirectory: true }],
          change: '4520',
          source: 'sync',
          at: 500,
          complete: true,
        },
      ],
    }
    await start(saviorEntry(4522, 1000))
    const before = ledgerText()
    // A real seed, so the assertions below are about a file that exists: an
    // absent ledger reads as '' and would pass whatever the read did.
    expect(before).toContain('4520')
    expect(syncPoint()?.id).toBe('4522')
    expect(ledgerText()).toBe(before)
  })

  it('answers nothing when no record covers the workspace', async () => {
    await start({
      '//depot/branch_x': [
        {
          ClientName: 'other',
          ClientRoot: join(dir, 'elsewhere'),
          ChangeNum: 4522,
          Timestamp: 1000,
        },
      ],
    })
    expect(syncPoint()).toBeNull()
  })
})
