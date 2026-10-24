/**
 * Command-layer tests for the sync history: drive the real `activate()`
 * handlers with a real `SyncHistoryLog` under a temp `globalStoragePath`, then
 * read back the JSON the host page renders.
 *
 * What this file exists to hold down:
 *  1. Exactly ONE record per get — including the runs the graph ledger must not
 *     record (cancelled, failed, declined at the scope gate).
 *  2. The trigger column tells the truth: the surface that started the get, with
 *     the force retry marked `recovery` rather than inheriting its caller's.
 *  3. The scope is recorded in host paths, and it is the range the get covered —
 *     not the client root, and not the expanded filespecs.
 *  4. `facts` (engine, IO bytes, threads, watcher writes) reach the record.
 *  5. The two read commands answer from the file with zero p4 calls, and drop
 *     arguments that do not fit instead of coercing them.
 *  6. `openLog` resolves the run reference off the RECORD and reads it from the
 *     extension's own log directory — never a path the caller named, and never
 *     "the latest log" for a get whose δ run does not exist.
 */
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { SyncHistoryEntry } from '../syncHistory.js'
import type {
  P4SyncRunDetailDto,
  P4SyncHistoryLoadResult,
} from '@universe-editor/extensions-common'

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
    // Typed with a rest parameter so a test can install an implementation that
    // inspects the command id (the active-editor probe) without a cast.
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  }
})

const windowMock = vi.hoisted(() => {
  /** 频道收到的行，按频道名分开：P4delta 与 Perforce 是两条独立的账。 */
  const channels = new Map<string, string[]>()
  /** 建出来的频道对象本身，供断言 `show()`。 */
  const createdChannels = new Map<string, { show: ReturnType<typeof vi.fn> }>()
  const channelsOf = (name: string): string[] => {
    let lines = channels.get(name)
    if (lines === undefined) {
      lines = []
      channels.set(name, lines)
    }
    return lines
  }
  return {
    channels,
    createdChannels,
    channelsOf,
    createOutputChannel: vi.fn((name: string) => {
      const channel = {
        name,
        append: (text: string) => void channelsOf(name).push(text),
        appendLine: (text: string) => void channelsOf(name).push(`${text}\n`),
        replace: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      }
      createdChannels.set(name, channel)
      return channel
    }),
    showInformationMessage: vi.fn(async () => undefined as string | undefined),
    showWarningMessage: vi.fn(async () => undefined as string | undefined),
    showErrorMessage: vi.fn(async () => undefined as string | undefined),
    showQuickPick: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined as string | undefined),
    showTextDocument: vi.fn(async () => undefined),
    withProgress: vi.fn(
      async (_opts: unknown, fn: (progress: unknown, token: unknown) => Promise<unknown>) =>
        fn({ report: vi.fn() }, { onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) }),
    ),
  }
})

const workspaceMock = vi.hoisted(() => {
  /** Settings a test has overridden; anything else answers its declared default. */
  const configValues = new Map<string, unknown>()
  const configListeners: ((e: { affectsConfiguration(key: string): boolean }) => void)[] = []
  const get = vi.fn(async (key: string, def: unknown) =>
    configValues.has(key) ? configValues.get(key) : def,
  )
  return {
    rootPath: ROOT,
    configValues,
    configListeners,
    getConfiguration: vi.fn(() => ({ get })),
    openTextDocument: vi.fn(async (options?: { content?: string; language?: string }) => ({
      uri: { toString: () => 'untitled:log' },
      languageId: options?.language ?? 'plaintext',
      getText: () => options?.content ?? '',
    })),
    onDidChangeConfiguration: vi.fn(
      (listener: (e: { affectsConfiguration(key: string): boolean }) => void) => {
        configListeners.push(listener)
        return { dispose: vi.fn() }
      },
    ),
    registerTimelineProvider: vi.fn(() => ({ dispose: vi.fn() })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  commands: commandsMock,
  window: windowMock,
  workspace: workspaceMock,
  chat: { registerChatContextProvider: vi.fn(() => ({ dispose: vi.fn() })) },
  ProgressLocation: { Notification: 15 },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
}))

type Mock = ReturnType<typeof vi.fn>

/** The run result the fake client hands back; the tests reshape it per case. */
interface FakeRunResult {
  ok: boolean
  cancelled: boolean
  summary:
    | {
        applied: number
        trackedDeleted?: number
        untrackedDeleted?: number
        keptOpen: number
        mustResolve: number
        refusedModified: number
        refusedOverwrite: number
        handoff: number
        upToDate: boolean
      }
    | undefined
  refusedFiles: unknown[]
  refusedOverwriteFiles: unknown[]
  error: { kind: string; suggestion: string } | undefined
  /** The client refused the get before spawning anything (`SyncRunResult.notRun`). */
  notRun?: boolean
  facts?: {
    engine: 'p4' | 'p4delta'
    engineFallback: boolean
    parallelThreads: number
    startedAt: number
    endedAt: number
    io?: { readBytes: number; writeBytes: number }
    diskWrites: number
    p4Calls: {
      native: number
      p4delta: number
      complete: boolean
      p4deltaByCommand?: Record<string, number>
    }
    deltaRunId?: string
  }
}

function appliedRun(overrides: Partial<FakeRunResult> = {}): FakeRunResult {
  return {
    ok: true,
    cancelled: false,
    summary: {
      applied: 1,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      handoff: 0,
      upToDate: false,
    },
    refusedFiles: [],
    refusedOverwriteFiles: [],
    error: undefined,
    ...overrides,
  }
}

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
  setP4delta: Mock
  dispose: Mock
  cancelBusy: Mock
  reconcile: Mock
  refreshScope: Mock
  setScopeNoticeHandler: Mock
  invalidateScope: Mock
  scopeState: 'ready'
  scopeUnusableReason: string | undefined
  dailyScope: undefined
  reconcileExcludeDirs: readonly string[]
  reconcileExcludeFiles: readonly string[]
  scopeExcludeDirs: readonly string[]
  reconcileNoise: { dirs: readonly string[]; files: readonly string[] }
  setReconcileExcludes: Mock
  nativeWriteReject: Mock
  isReconcileTargetExcluded: Mock
  driftGroupPaths: Mock
  reconcileUsesP4delta: boolean
  p4deltaDeleteUntrackedReject: Mock
  checkScopeTargets: Mock
}

/** Only what this file's commands touch; everything else is a no-op stub so
 *  `activate` can wire the rest of the extension without a real client. */
function makeFakeClient(): FakeClient {
  const fake = {} as FakeClient
  fake.root = ROOT
  fake.clientName = 'testclient'
  fake.user = 'testuser'
  fake.syncScopeDirs = [SRC]
  fake.syncScopes = [`${SRC}/...`]
  fake.status = {}
  fake.sync = vi.fn(async () => appliedRun())
  // The graph ledger's read-back, paid by every successful get below. Not this
  // file's subject — the ledger's own tests count it — so it just answers.
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
  fake.setP4delta = vi.fn()
  fake.dispose = vi.fn()
  fake.cancelBusy = vi.fn()
  fake.reconcile = vi.fn(async () => {})
  fake.refreshScope = vi.fn(async () => 'ready')
  fake.setScopeNoticeHandler = vi.fn()
  fake.invalidateScope = vi.fn()
  fake.scopeState = 'ready'
  fake.scopeUnusableReason = undefined
  fake.dailyScope = undefined
  fake.reconcileExcludeDirs = []
  fake.reconcileExcludeFiles = []
  fake.scopeExcludeDirs = []
  fake.reconcileNoise = { dirs: [], files: [] }
  fake.setReconcileExcludes = vi.fn()
  fake.nativeWriteReject = vi.fn(() => undefined)
  fake.isReconcileTargetExcluded = vi.fn(() => false)
  fake.driftGroupPaths = vi.fn(() => [])
  fake.reconcileUsesP4delta = false
  // 这份文件不测删除未跟踪档：默认按「δ 没在服务本会话」答，强制确认框只出一个按钮。
  fake.p4deltaDeleteUntrackedReject = vi.fn(() => 'gets are not routed to p4delta in this session')
  // Everything a test names is in range, so the gate never opens a dialog and
  // the get runs as asked. The declined test below replaces this answer.
  fake.checkScopeTargets = vi.fn(async (targets: readonly { path: string }[]) => ({
    state: 'ready' as const,
    reason: undefined,
    inside: targets,
    outside: [],
  }))
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
// `activate` runs the engine gate too; pin its probe so a real (old) p4delta on
// the host PATH cannot raise the version warning into these assertions.
vi.mock('../p4delta/p4deltaService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../p4delta/p4deltaService.js')>()
  return { ...actual, probeP4deltaBuild: async () => [0, 1, 21] }
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

const BTN_FORCE = localize('perforce.btn.forceSync', 'Force Get')

let fake: FakeClient
let storage: string

/** The file the host page reads, as the extension wrote it. */
function records(): SyncHistoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(storage, 'syncHistory.json'), 'utf8')) as {
      entries?: SyncHistoryEntry[]
    }
    return raw.entries ?? []
  } catch {
    // No file yet — a run that recorded nothing, which several tests assert.
    return []
  }
}

/** Newest first, the order the page renders. */
function newestFirst(): SyncHistoryEntry[] {
  return [...records()].sort((a, b) => b.at - a.at)
}

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
  const handler = commandsMock.handlers.get(id)
  expect(handler, `command ${id} registered`).toBeDefined()
  await handler!(...args)
}

async function commandResult(id: string, ...args: unknown[]): Promise<unknown> {
  const handler = commandsMock.handlers.get(id)
  expect(handler, `command ${id} registered`).toBeDefined()
  return await handler!(...args)
}

beforeEach(async () => {
  fake = makeFakeClient()
  clientMock.state.current = fake
  storage = mkTempDir('p4-sync-history-cmd-')
  commandsMock.handlers.clear()
  // Reset, not just clear: a test that installs an `_workbench.getActiveEditorFile`
  // answer must not hand it to the next one.
  commandsMock.executeCommand.mockReset()
  commandsMock.executeCommand.mockResolvedValue(undefined)
  // Overrides and subscribers from the previous test would otherwise be re-read
  // by this test's `activate()`.
  workspaceMock.configValues.clear()
  workspaceMock.configListeners.length = 0
  windowMock.showInformationMessage.mockClear()
  windowMock.showWarningMessage.mockClear()
  windowMock.showErrorMessage.mockClear()
  windowMock.showTextDocument.mockClear()
  windowMock.channels.clear()
  windowMock.createdChannels.clear()
  workspaceMock.openTextDocument.mockClear()
  // The default answer is "dismissed": no button, no override. Tests that need a
  // confirmation say yes explicitly.
  windowMock.showWarningMessage.mockResolvedValue(undefined)
  windowMock.showErrorMessage.mockResolvedValue(undefined)
  await activate({ subscriptions: [], globalStoragePath: storage } as never)
  expect(clientMock.create).toHaveBeenCalled()
})

describe('one record per get', () => {
  it('records an applied get with its counts and the range it covered', async () => {
    await runCommand('perforce.syncLatest')

    const entries = records()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      clientRoot: ROOT,
      spec: '#head',
      force: false,
      // 新记录恒带这一项：普通的非强制 get 明确写「否」，与旧记录的「缺席」区分开。
      deleteUntracked: false,
      trigger: 'command',
      outcome: 'applied',
      counts: {
        applied: 1,
        refusedModified: 0,
        refusedOverwrite: 0,
        keptOpen: 0,
        mustResolve: 0,
        handoff: 0,
        untrackedDeleted: 0,
      },
      // Host paths, not filespecs, and the DAILY scope rather than the client
      // root: a scope-less get is bounded by the scope, and recording the root
      // would claim the whole workspace moved.
      scope: [{ path: SRC, isDirectory: true }],
      scopeNarrowed: false,
    })
    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(entries[0]?.scopeOmitted).toBe(0)
    // No `facts` on this run: the entry must not invent an engine or a byte
    // count it never observed.
    expect(entries[0]?.engine).toBeUndefined()
    expect(entries[0]?.io).toBeUndefined()
    expect(entries[0]?.diskWrites).toBeUndefined()
    // A get with no facts must not read as "asked p4 nothing".
    expect(entries[0]?.p4Calls).toBeUndefined()
  })

  it('carries the client facts onto the record', async () => {
    const startedAt = Date.now() - 4200
    fake.sync.mockResolvedValue(
      appliedRun({
        facts: {
          engine: 'p4delta',
          engineFallback: false,
          parallelThreads: 6,
          startedAt,
          endedAt: Date.now(),
          io: { readBytes: 4096, writeBytes: 512 },
          diskWrites: 12,
          p4Calls: { native: 0, p4delta: 9, complete: true },
        },
      }),
    )

    await runCommand('perforce.syncLatest')

    const entry = records()[0]
    expect(entry).toMatchObject({
      engine: 'p4delta',
      engineFallback: false,
      parallelThreads: 6,
      io: { readBytes: 4096, writeBytes: 512 },
      diskWrites: 12,
      p4Calls: { native: 0, p4delta: 9, complete: true },
      startedAt,
    })
    // The duration comes from the client's own clock, not from the command
    // layer's stopwatch (which would include the progress UI's tail).
    expect(entry?.durationMs).toBeGreaterThanOrEqual(4000)
  })

  it('does not record the same get twice', async () => {
    await runCommand('perforce.syncLatest')
    await runCommand('perforce.syncLatest')
    // Two runs, two entries — one each. A second write per run (or a re-record
    // on the ledger path) would show up here as a multiple of the run count.
    expect(records()).toHaveLength(2)
    expect(new Set(records().map((e) => e.id)).size).toBe(2)
  })

  it('records a cancelled get instead of dropping it', async () => {
    fake.sync.mockResolvedValue(appliedRun({ ok: false, cancelled: true, summary: undefined }))

    await runCommand('perforce.syncLatest')

    expect(records()[0]?.outcome).toBe('cancelled')
  })

  it('separates an up-to-date get from one p4 never made legible', async () => {
    fake.sync.mockResolvedValueOnce(
      appliedRun({
        summary: {
          applied: 0,
          keptOpen: 0,
          mustResolve: 0,
          refusedModified: 0,
          refusedOverwrite: 0,
          handoff: 0,
          upToDate: true,
        },
      }),
    )
    await runCommand('perforce.syncLatest')

    fake.sync.mockResolvedValueOnce(
      appliedRun({
        summary: {
          applied: 0,
          keptOpen: 0,
          mustResolve: 0,
          refusedModified: 0,
          refusedOverwrite: 0,
          handoff: 0,
          upToDate: false,
        },
      }),
    )
    await runCommand('perforce.syncLatest')

    const outcomes = records().map((e) => e.outcome)
    // One record per run, each classified from its OWN summary. Two runs inside
    // the same millisecond have no defined order (the data layer's tests say the
    // same about same-`at` rows), so this compares contents, not sequence.
    expect(outcomes).toHaveLength(2)
    expect(new Set(outcomes)).toEqual(new Set(['upToDate', 'unrecognized']))
  })
})
describe('the trigger column', () => {
  it('records the status bar as the surface for its own entry point', async () => {
    await runCommand('perforce.syncLatestFromStatusBar')
    expect(records()[0]?.trigger).toBe('statusBar')
  })

  it('records a menu invocation as explorer', async () => {
    // An active editor is present too: the argument must win over the fallback,
    // both for the trigger and for the scope.
    commandsMock.executeCommand.mockImplementation(async (id: unknown) =>
      id === '_workbench.getActiveEditorFile' ? `${SRC}/active.cpp` : undefined,
    )

    await runCommand('perforce.syncLatest', { resourceUri: `${SRC}/a.cpp` })

    const entry = records()[0]
    expect(entry?.trigger).toBe('explorer')
    // The clicked file is the range, as a host path with its directory-ness.
    expect(entry?.scope).toEqual([{ path: `${SRC}/a.cpp`, isDirectory: false }])
  })

  it('does not report the status bar chip as an explorer click', async () => {
    // The chip is a no-argument command that falls back to the active editor's
    // file for its scope — the very fallback that used to make it look like an
    // Explorer click. The column has to follow the ARGUMENT (none), not the
    // resolved path.
    commandsMock.executeCommand.mockImplementation(async (id: unknown) =>
      id === '_workbench.getActiveEditorFile' ? `${SRC}/active.cpp` : undefined,
    )

    await runCommand('perforce.syncLatestFromStatusBar')

    const entry = records()[0]
    expect(entry?.trigger).toBe('statusBar')
    // …while the scope still is the file the chip describes.
    expect(entry?.scope).toEqual([{ path: `${SRC}/active.cpp`, isDirectory: false }])
  })

  it('does not report an argument-less palette call as an explorer click', async () => {
    commandsMock.executeCommand.mockImplementation(async (id: unknown) =>
      id === '_workbench.getActiveEditorFile' ? `${SRC}/active.cpp` : undefined,
    )

    await runCommand('perforce.syncLatest')

    expect(records()[0]?.trigger).toBe('command')
  })

  it('marks both retries of a clobbered get as recovery, not as the caller', async () => {
    fake.sync
      .mockResolvedValueOnce(
        appliedRun({
          ok: false,
          summary: undefined,
          error: { kind: 'clobber', suggestion: 'local changes' },
        }),
      )
      .mockResolvedValueOnce(appliedRun())
    // "Force Get" on the failure toast, then "Force Get" in the confirmation.
    windowMock.showErrorMessage.mockResolvedValue(BTN_FORCE)
    windowMock.showWarningMessage.mockResolvedValue(BTN_FORCE)

    await runCommand('perforce.syncLatest')

    const entries = newestFirst()
    expect(entries).toHaveLength(2)
    // The failed attempt is attributed to the surface the user clicked...
    const failed = entries.find((e) => e.outcome === 'failed')
    const retried = entries.find((e) => e.force)
    expect(failed?.trigger).toBe('command')
    // ...while the retry says what it is, so the list does not read as two
    // separate user actions.
    expect(retried?.trigger).toBe('recovery')
    expect(retried?.outcome).toBe('applied')
  })
})

describe('a get that never ran', () => {
  it('records the declined scope gate and does not spawn p4', async () => {
    fake.checkScopeTargets.mockResolvedValue({
      state: 'ready',
      reason: undefined,
      inside: [],
      outside: [{ path: `${SRC}/a.cpp`, isDirectory: false }],
    })
    // The user dismisses the gate: neither "obey the scope" nor "run as chosen".
    windowMock.showWarningMessage.mockResolvedValue(undefined)

    await runCommand('perforce.syncLatest', { resourceUri: `${SRC}/a.cpp` })

    expect(fake.sync).not.toHaveBeenCalled()
    const entry = records()[0]
    expect(entry).toMatchObject({
      outcome: 'declined',
      trigger: 'explorer',
      // The range the user asked for, not one the get "would have" covered.
      scope: [{ path: `${SRC}/a.cpp`, isDirectory: false }],
      durationMs: 0,
    })
    expect(entry?.engine).toBeUndefined()
    expect(entry?.counts).toBeUndefined()
  })

  it('records the client’s own pre-flight refusal as Not run, with its reason', async () => {
    // The second way a get never runs: the client refused the range itself
    // (`notRun`) after the gate had already said yes.
    fake.sync.mockResolvedValue(
      appliedRun({
        ok: false,
        notRun: true,
        summary: undefined,
        error: { kind: 'other', suggestion: 'the daily scope is not usable (unreadable)' },
      }),
    )

    await runCommand('perforce.syncLatest')

    const entry = records()[0]
    expect(entry).toMatchObject({
      outcome: 'declined',
      // Structural zero: the refusal is not a get anyone could time.
      durationMs: 0,
      // "Not run" alone leaves nowhere to read WHY.
      error: { kind: 'other', message: 'the daily scope is not usable (unreadable)' },
    })
    // No engine ran, so nothing may be named — an `engine: 'p4'` here would be
    // the column guessing about a process that never started.
    expect(entry?.engine).toBeUndefined()
    expect(entry?.diskWrites).toBeUndefined()
    expect(entry?.counts).toBeUndefined()
    // The client already told the user why. A second toast would restate the
    // same reason under a "Get revision failed" headline, for a get that never ran.
    expect(windowMock.showErrorMessage).not.toHaveBeenCalled()
  })
})

describe('perforce-sync-history read commands', () => {
  it('answers getRuns with the page, the total and the has-more flag', async () => {
    await runCommand('perforce.syncLatest')
    await runCommand('perforce.syncLatestFromStatusBar')
    await runCommand('perforce.syncLatest')

    const page = (await commandResult('perforce-sync-history.getRuns', {
      max: 2,
    })) as P4SyncHistoryLoadResult

    expect(page.runs).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(page.hasMore).toBe(true)
    expect(page.runs[0]).toMatchObject({ spec: '#head', clientRoot: ROOT })
    // The list row carries the trimmed scope only — the full one is the detail
    // call's job, so a 200-row page stays small.
    expect(page.runs[0]).toHaveProperty('scopeFirst')
    expect(page.runs[0]).not.toHaveProperty('scope')
    expect(page.runs[0]?.scopeCount).toBe(1)
  })

  it('answers getRun with the complete scope', async () => {
    await runCommand('perforce.syncLatest')
    const id = records()[0]!.id

    const detail = (await commandResult('perforce-sync-history.getRun', id)) as P4SyncRunDetailDto

    expect(detail.id).toBe(id)
    expect(detail.scope).toEqual([{ path: SRC, isDirectory: true }])
    expect(detail.scopeOmitted).toBe(0)
  })

  it('carries the p4-call split through to the list DTO', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        facts: {
          engine: 'p4',
          engineFallback: false,
          parallelThreads: 4,
          startedAt: Date.now() - 100,
          endedAt: Date.now(),
          diskWrites: 0,
          p4Calls: { native: 1, p4delta: 0, complete: true },
        },
      }),
    )
    await runCommand('perforce.syncLatest')

    const page = (await commandResult('perforce-sync-history.getRuns', {
      max: 10,
    })) as P4SyncHistoryLoadResult

    // The page the Sync History UI reads is where the row gets its count; a
    // record with the group absent must keep it absent here (no `?? 0`).
    expect(page.runs[0]?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('answers an unknown id and a missing file without inventing a record', async () => {
    // `null` — this command ran and has no such record. The renderer needs that
    // apart from `undefined` (an unregistered command = no perforce extension
    // here), so a bad id must not answer with the latter.
    expect(await commandResult('perforce-sync-history.getRun', 'nope')).toBeNull()
    expect(await commandResult('perforce-sync-history.getRuns')).toEqual({
      runs: [],
      total: 0,
      hasMore: false,
    })
  })

  it('drops arguments that do not fit instead of coercing them', async () => {
    await runCommand('perforce.syncLatest')

    const page = (await commandResult('perforce-sync-history.getRuns', {
      max: 'huge',
      root: 7,
    })) as P4SyncHistoryLoadResult

    // Default page, no root filter — the record is still there.
    expect(page.total).toBe(1)
    expect(page.runs).toHaveLength(1)
    // A non-string id is dropped to the same "no such record" answer rather than
    // coerced into a lookup.
    expect(await commandResult('perforce-sync-history.getRun', { id: 'nope' })).toBeNull()
  })
})

/**
 * 「打开 p4delta 日志」这条链路：runId 从记录上取、文件只从扩展自己的日志目录读、失败各有
 * 一句明确的话。这里用真的 `P4deltaRunLog` 目录（`<globalStoragePath>/p4delta-logs`）——
 * 命令层拿到的就是一个 runId，而不是一个路径。
 */
describe('opening a δ run log', () => {
  const LOG_DIR = (): string => join(storage, 'p4delta-logs')
  const RUN_ID = 'p4d-1700000000000-4242-1-abcd1234'

  function deltaFacts(runId: string): FakeRunResult {
    return appliedRun({
      facts: {
        engine: 'p4delta',
        engineFallback: false,
        parallelThreads: 4,
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        diskWrites: 0,
        p4Calls: { native: 0, p4delta: 7, complete: true },
        deltaRunId: runId,
      },
    })
  }

  function writeLog(runId: string, text: string, at?: number): void {
    mkdirSync(LOG_DIR(), { recursive: true })
    const file = join(LOG_DIR(), `${runId}.log`)
    writeFileSync(file, text, 'utf8')
    if (at !== undefined) utimesSync(file, at / 1000, at / 1000)
  }

  it('opens the log the record points at, as a bounded snapshot document', async () => {
    fake.sync.mockResolvedValue(deltaFacts(RUN_ID))
    await runCommand('perforce.syncLatest')
    const id = records()[0]!.id
    expect(records()[0]?.deltaRunId).toBe(RUN_ID)
    writeLog(RUN_ID, '=== p4delta run ===\nstaging 12 files\n')

    const result = await commandResult('perforce-sync-history.openLog', id)

    expect(result).toEqual({ ok: true, active: false, truncated: false })
    // The content goes through an untitled document: on a remote host the log is
    // not a file the UI could open by URI at all.
    expect(workspaceMock.openTextDocument).toHaveBeenCalledWith({
      content: '=== p4delta run ===\nstaging 12 files\n',
      language: 'log',
    })
    expect(windowMock.showTextDocument).toHaveBeenCalled()
  })

  it('never opens the latest log for a record whose δ run does not exist', async () => {
    // A plain native get: no δ log reference, and the directory happens to hold
    // somebody else's run. Answering with that file would show diagnostics for a
    // run the user never asked about.
    await runCommand('perforce.syncLatest')
    const id = records()[0]!.id
    writeLog('p4d-1700000000000-1-1-ffffffff', 'another run entirely\n')

    const result = await commandResult('perforce-sync-history.openLog', id)

    expect(result).toEqual({ ok: false, reason: 'unknown-run' })
    expect(workspaceMock.openTextDocument).not.toHaveBeenCalled()
    expect(windowMock.showInformationMessage).toHaveBeenCalled()
  })

  it('says the log is gone instead of opening an empty document', async () => {
    fake.sync.mockResolvedValue(deltaFacts(RUN_ID))
    await runCommand('perforce.syncLatest')
    const id = records()[0]!.id
    // The retention policy (or a session on another machine) took it away.

    const result = await commandResult('perforce-sync-history.openLog', id)

    expect(result).toEqual({ ok: false, reason: 'log-missing' })
    expect(workspaceMock.openTextDocument).not.toHaveBeenCalled()
    expect(windowMock.showWarningMessage).toHaveBeenCalled()
  })

  it('answers an unknown history id with the same "no run" shape', async () => {
    const result = await commandResult('perforce-sync-history.openLog', 'not-a-record')
    expect(result).toEqual({ ok: false, reason: 'unknown-run' })
    expect(workspaceMock.openTextDocument).not.toHaveBeenCalled()
  })

  it('opens the newest run log for the palette command', async () => {
    writeLog('p4d-1700000000000-1-1-aaaaaaaa', 'older\n', 1_700_000_000_000)
    writeLog('p4d-1700000000001-1-2-bbbbbbbb', 'newer\n', 1_700_000_100_000)

    const result = await commandResult('perforce.openLatestP4deltaLog')

    expect(result).toEqual({ ok: true, active: false, truncated: false })
    expect(workspaceMock.openTextDocument).toHaveBeenCalledWith({
      content: 'newer\n',
      language: 'log',
    })
  })

  it('has nothing to open before any run, and says so', async () => {
    const result = await commandResult('perforce.openLatestP4deltaLog')

    expect(result).toEqual({ ok: false, reason: 'log-missing' })
    expect(workspaceMock.openTextDocument).not.toHaveBeenCalled()
  })

  it('shows the P4delta channel for the show-output command', async () => {
    await runCommand('perforce.showP4deltaOutput')

    const delta = windowMock.createdChannels.get('P4delta')
    expect(delta?.show).toHaveBeenCalled()
    // 两条账互不打扰：p4 自己的输出不会因为这次调用被翻出来。
    expect(windowMock.createdChannels.get('Perforce')?.show).not.toHaveBeenCalled()
  })
})

/** A summary that reports no per-file outcome at all. */
function emptySummary(upToDate: boolean): FakeRunResult {
  return appliedRun({
    summary: {
      applied: 0,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      handoff: 0,
      upToDate,
    },
  })
}

/** Flip a `perforce.*` setting the way the host does: the cached watch re-reads. */
async function setConfig(fullKey: string, value: unknown): Promise<void> {
  // `workspace.getConfiguration('perforce')` is mocked at the section boundary,
  // so its `get` takes the section-relative key while `affectsConfiguration`
  // takes the full one — the mock reproduces the API's own split.
  workspaceMock.configValues.set(fullKey.replace(/^perforce\./, ''), value)
  for (const listener of workspaceMock.configListeners) {
    listener({ affectsConfiguration: (k) => k === fullKey })
  }
  // The change-driven re-read is async and deliberately unawaited by the watch.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a finished get reaches a user who left the window', () => {
  /** Every desktop notification the command layer asked the bridge to raise. */
  function notifications(): { title: string; body: string }[] {
    return commandsMock.executeCommand.mock.calls
      .filter((call) => call[0] === '_workbench.showSystemNotification')
      .map((call) => call[1] as { title: string; body: string })
  }

  const TITLE_DONE = localize('perforce.sync.notify.done', 'Get complete')
  const TITLE_FAILED = localize('perforce.sync.notify.failed', 'Get failed')
  const TITLE_UNKNOWN = localize('perforce.sync.notify.unknown', 'Get result unclear')

  it('reports an applied get with the counts the toast shows', async () => {
    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([
      {
        title: TITLE_DONE,
        body: localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: '1' }),
      },
    ])
  })

  // 纯删除的一轮 applied == trackedDeleted：此时「Updated 0 file(s)」既刺眼又是谎话（磁盘上
  // 确实少了文件），只报删除数。
  it('reports a tracked-only deletion without claiming zero updates', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        summary: {
          applied: 1,
          trackedDeleted: 1,
          keptOpen: 0,
          mustResolve: 0,
          refusedModified: 0,
          refusedOverwrite: 0,
          handoff: 0,
          upToDate: false,
        },
      }),
    )

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([
      {
        title: TITLE_DONE,
        body: localize('perforce.sync.trackedDeleted', '{0} tracked file(s) deleted', {
          0: '1',
        }),
      },
    ])
  })

  it('reports updates and tracked deletions as separate numbers', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        summary: {
          applied: 3,
          trackedDeleted: 1,
          keptOpen: 0,
          mustResolve: 0,
          refusedModified: 0,
          refusedOverwrite: 0,
          handoff: 0,
          upToDate: false,
        },
      }),
    )

    await runCommand('perforce.syncLatest')

    expect(notifications()[0]?.body).toBe(
      `${localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: '2' })} · ${localize(
        'perforce.sync.trackedDeleted',
        '{0} tracked file(s) deleted',
        { 0: '1' },
      )}`,
    )
  })

  it('reports both deletion kinds alongside the update count', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        summary: {
          applied: 3,
          trackedDeleted: 1,
          untrackedDeleted: 2,
          keptOpen: 0,
          mustResolve: 0,
          refusedModified: 0,
          refusedOverwrite: 0,
          handoff: 0,
          upToDate: false,
        },
      }),
    )

    await runCommand('perforce.syncLatest')

    expect(notifications()[0]?.body).toBe(
      [
        localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: '2' }),
        localize('perforce.sync.trackedDeleted', '{0} tracked file(s) deleted', { 0: '1' }),
        localize('perforce.sync.untrackedDeleted', '{0} untracked file(s) deleted', { 0: '2' }),
      ].join(' · '),
    )
  })

  it('reports an up-to-date get instead of staying silent', async () => {
    fake.sync.mockResolvedValue(emptySummary(true))

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([
      {
        title: TITLE_DONE,
        body: localize('perforce.sync.upToDate', 'Already at the latest revision.'),
      },
    ])
  })

  it('reports a get p4 never made legible', async () => {
    fake.sync.mockResolvedValue(emptySummary(false))

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([
      {
        title: TITLE_UNKNOWN,
        body: localize(
          'perforce.sync.unrecognized',
          'Get revision returned no recognized result. Check the Perforce output for details.',
        ),
      },
    ])
  })

  it('reports a failure before the dialog that would suppress it', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        ok: false,
        summary: undefined,
        error: { kind: 'other', suggestion: 'the server went away' },
      }),
    )

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([
      {
        title: TITLE_FAILED,
        body: localize('perforce.sync.failed', 'Get revision failed. {0}', {
          0: 'the server went away',
        }).trim(),
      },
    ])
    // The error toast waits for the user; if the notification were sent after it,
    // the window would be focused again by then and the desktop toast suppressed
    // — i.e. it would never be seen at the one moment it matters.
    const notifyIndex = commandsMock.executeCommand.mock.calls.findIndex(
      (call) => call[0] === '_workbench.showSystemNotification',
    )
    const notifyOrder = commandsMock.executeCommand.mock.invocationCallOrder[notifyIndex]
    expect(notifyOrder).toBeLessThan(windowMock.showErrorMessage.mock.invocationCallOrder[0]!)
  })

  it('reports both halves of a clobbered get: the failure and its retry', async () => {
    fake.sync
      .mockResolvedValueOnce(
        appliedRun({
          ok: false,
          summary: undefined,
          error: { kind: 'clobber', suggestion: 'local changes' },
        }),
      )
      .mockResolvedValueOnce(appliedRun())
    windowMock.showErrorMessage.mockResolvedValue(BTN_FORCE)
    windowMock.showWarningMessage.mockResolvedValue(BTN_FORCE)

    await runCommand('perforce.syncLatest')

    expect(notifications().map((n) => n.title)).toEqual([TITLE_FAILED, TITLE_DONE])
  })

  it('stays silent for a get the user cancelled', async () => {
    fake.sync.mockResolvedValue(appliedRun({ ok: false, cancelled: true, summary: undefined }))

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([])
  })

  it('stays silent for a get the scope gate declined', async () => {
    fake.checkScopeTargets.mockResolvedValue({
      state: 'ready',
      reason: undefined,
      inside: [],
      outside: [{ path: `${SRC}/a.cpp`, isDirectory: false }],
    })
    windowMock.showWarningMessage.mockResolvedValue(undefined)

    await runCommand('perforce.syncLatest', { resourceUri: `${SRC}/a.cpp` })

    expect(notifications()).toEqual([])
  })

  it('stays silent for the client’s own pre-flight refusal', async () => {
    fake.sync.mockResolvedValue(
      appliedRun({
        ok: false,
        notRun: true,
        summary: undefined,
        error: { kind: 'other', suggestion: 'the daily scope is not usable' },
      }),
    )

    await runCommand('perforce.syncLatest')

    expect(notifications()).toEqual([])
  })

  it('sends nothing while the setting is off, and resumes once it is back on', async () => {
    await setConfig('perforce.syncNotifications.enabled', false)
    await runCommand('perforce.syncLatest')
    expect(notifications()).toEqual([])

    await setConfig('perforce.syncNotifications.enabled', true)
    await runCommand('perforce.syncLatest')
    expect(notifications()).toHaveLength(1)
  })

  it('does not let a stalled bridge hold the get open', async () => {
    // Fire-and-forget by contract: the host settles `notify` only on click,
    // dismiss or its own click grace, so awaiting the bridge here would stall
    // every caller that reads "the command resolved = the get is done".
    commandsMock.executeCommand.mockImplementation(async (id: unknown) =>
      id === '_workbench.showSystemNotification' ? new Promise<never>(() => {}) : undefined,
    )

    await expect(runCommand('perforce.syncLatest')).resolves.toBeUndefined()
  })
})

/** The renderer lane the Sync History page answers, so a record landing reloads
 *  the page instead of waiting for a click on Refresh. Literal on purpose: the
 *  renderer side pins the same string, and either side renaming it must fail
 *  here (a mismatch is otherwise silent — the renderer only logs a warning). */
const POKE = '_workbench.perforceSyncHistoryRecorded'

const pokes = (): unknown[][] =>
  commandsMock.executeCommand.mock.calls.filter((call) => call[0] === POKE)

describe('the renderer poke', () => {
  it('pokes once per get, after the record is readable', async () => {
    let seenWhenPoked = -1
    commandsMock.executeCommand.mockImplementation(async (id: unknown) => {
      if (id === POKE) seenWhenPoked = records().length
      return undefined
    })

    await runCommand('perforce.syncLatest')

    expect(pokes()).toHaveLength(1)
    // The page's reload is a file read: poking before the write would make it
    // read the history without the very record that triggered it.
    expect(seenWhenPoked).toBe(1)
  })

  it('pokes for a declined get too', async () => {
    // The page has to show this row — "I clicked get and nothing happened" is
    // exactly the record a stale list hides.
    fake.checkScopeTargets.mockResolvedValue({
      state: 'ready',
      reason: undefined,
      inside: [],
      outside: [{ path: `${SRC}/a.cpp`, isDirectory: false }],
    })
    windowMock.showWarningMessage.mockResolvedValue(undefined)

    await runCommand('perforce.syncLatest', { resourceUri: `${SRC}/a.cpp` })

    expect(records()[0]?.outcome).toBe('declined')
    expect(pokes()).toHaveLength(1)
  })

  it('keeps a rejected poke from failing the get', async () => {
    // The renderer may be gone (a window closing mid-get). The record is already
    // on disk, so the get is not the poke's hostage — and an escaping rejection
    // here would surface as an unhandled rejection in the host process.
    commandsMock.executeCommand.mockImplementation(async (id: unknown) => {
      if (id === POKE) throw new Error('renderer gone')
      return undefined
    })

    await runCommand('perforce.syncLatest')

    expect(records()).toHaveLength(1)
    expect(pokes()).toHaveLength(1)
  })

  it('keeps a synchronously throwing poke from escaping', async () => {
    // The other failure shape: the IPC channel is already torn down, so the call
    // throws before it can return a promise. This is what the try/catch (rather
    // than only the rejection handler) is there for.
    commandsMock.executeCommand.mockImplementation((id: unknown) => {
      if (id === POKE) throw new Error('bridge gone')
      return Promise.resolve(undefined)
    })

    await runCommand('perforce.syncLatest')

    expect(records()).toHaveLength(1)
    expect(pokes()).toHaveLength(1)
  })

  it('never declares the poke id in the extension manifest', () => {
    // A command declared in package.json shadows the renderer's Action2 and
    // `executeCommand` then resolves to `undefined` without an error — the
    // silent-failure trap of src/swarm/CLAUDE.md, applied to this lane.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { contributes?: { commands?: { command?: string }[] } }
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.command)
    expect(declared).not.toContain(POKE)
  })
})
