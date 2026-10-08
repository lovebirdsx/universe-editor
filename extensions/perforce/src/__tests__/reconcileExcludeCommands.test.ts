/**
 * Command-layer gate tests for the two independent layers an explicit collect /
 * clean passes: the workspace scope (`.p4delta-scope`, `confirmScopeTargets`)
 * and the reconcile noise (`perforce.reconcile.excludeFolders`,
 * `confirmNoiseTargets`). Drives the real handlers captured from `activate()` —
 * the only place that wires carve results to toasts and p4 calls — with a fake
 * client whose predicates are the real `pathUtil` ones, and a mocked `readdir`
 * for the carve walks. Locks in:
 *  1. Multi-select / single-target collect carves excluded subtrees, warns about
 *     unreadable directories without aborting, and reports all-excluded without
 *     spawning.
 *  2. The collect-after-refusal remedy's branches: carved selection scope,
 *     untouched filespec scope, carved default-scope dirs.
 *  3. Revert gates `p4 clean` only (file filter / directory carve / carve failure
 *     skip / excluded skip) while `p4 revert` stays unfiltered.
 *  4. The noise layer: a batch target CONTAINING a noise folder is pruned
 *     silently, a target the noise COVERS is put to the user, "run as chosen"
 *     lifts the rule for that target alone, "skip them" narrows the clean's
 *     promise, and a scope override never lifts the noise.
 *  5. reopenTo drops scope-excluded uncollected files but still reopens opened
 *     ones — and asks about a noise-covered one instead of dropping it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collapseScopeDirs, containsAny, isUnderAny, norm } from '../pathUtil.js'
import { localize } from '../nls.js'
import { EMPTY_RECONCILE_NOISE } from '../reconcileNoise.js'

/** Platform-independent path build for fixtures and expectations: the carve walk
 *  appends children with `/` and keeps the caller's spelling, so the tests must
 *  do the same rather than inheriting the host separator from `node:path.join`. */
function posixJoin(...parts: string[]): string {
  return parts.join('/')
}

const ROOT = vi.hoisted(() => 'X:/p4ws/main')
const SRC = `${ROOT}/src`

const ALL_EXCLUDED = localize(
  'perforce.reconcile.allExcluded',
  'The selected paths are outside the workspace scope, or hidden by the exclusions in force.',
)
const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
const BTN_COLLECT = localize('perforce.btn.collectChanges', 'Collect Changes')
const BTN_OBEY = localize('perforce.scope.btn.obey', 'Use the workspace scope')
const BTN_RUN = localize('perforce.scope.btn.run', 'Run as chosen')
const BTN_SKIP = localize('perforce.noise.btn.skip', 'Skip them')

const readdirMock = vi.hoisted(() =>
  vi.fn<
    (
      dir: string,
    ) => Promise<Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>>
  >(),
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: unknown[]) => readdirMock(...(args as [string])),
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
  // Params are declared so tests can read the message text back out of
  // `mock.calls` — the confirm wording is part of what they assert.
  showWarningMessage: vi.fn(
    async (_message: string, ..._items: string[]) => undefined as string | undefined,
  ),
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
    // Exposed so a case can answer one config key differently; every other key
    // keeps returning its default.
    get,
    getConfiguration: vi.fn(() => ({ get })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
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
  ProgressLocation: { Notification: 15 },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
}))

const clientMock = vi.hoisted(() => {
  const state = { current: undefined as FakeClient | undefined }
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

import type { ScopeView } from '../scope.js'
import { scopeView } from './scopeFixture.js'
import { activate } from '../extension.js'

type Mock = ReturnType<typeof vi.fn>
type NoiseConfig = { dirs: readonly string[]; files: readonly string[] }

interface FakeClient {
  root: string
  clientName: string
  user: string
  syncScopeDirs: readonly string[]
  syncScopes: readonly string[]
  /** The scope's OWN exclusions — what `.p4delta-scope` states. */
  scopeExcludeDirs: readonly string[]
  scopeExcludeFiles: readonly string[]
  /** `perforce.reconcile.excludeFolders`, as `setReconcileExcludes` left it. */
  reconcileNoise: NoiseConfig
  /** scope ∪ noise, the set every reconcile-side predicate asks about. */
  reconcileExcludeDirs: readonly string[]
  reconcileExcludeFiles: readonly string[]
  setReconcileExcludes: Mock
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
  isReconcileTargetExcluded(path: string): boolean
  isScopeTargetExcluded(path: string): boolean
  reconcile: Mock
  sync: Mock
  openedStateAmong: Mock
  openedInTree: Mock
  openedInTrees: Mock
  revert: Mock
  revertReconcile: Mock
  changelistOf: Mock
  reconcileInto: Mock
  reopen: Mock
  driftGroupPaths: Mock
  pathsInChangelist: Mock
  newChangelist: Mock
  refreshScope: Mock
  setScopeNoticeHandler: Mock
  invalidateScope: Mock
  scopeState: 'unresolved' | 'ready' | 'empty' | 'blocked'
  scopeUnusableReason: string | undefined
  dailyScope: ScopeView | undefined
  checkScopeTargets: Mock
}

/** A client whose exclusion predicates are the real pathUtil ones, over the two
 *  layers the real client keeps apart (scope vs noise) and the merged view the
 *  reconcile-side questions are asked about. */
function makeFakeClient(): FakeClient {
  const fake = {} as FakeClient
  fake.root = ROOT
  fake.clientName = 'testclient'
  fake.user = 'testuser'
  fake.syncScopeDirs = [ROOT]
  fake.syncScopes = [`${ROOT}/...`]
  fake.scopeExcludeDirs = []
  fake.scopeExcludeFiles = []
  fake.reconcileNoise = EMPTY_RECONCILE_NOISE
  fake.reconcileExcludeDirs = []
  fake.reconcileExcludeFiles = []
  fake.setReconcileExcludes = vi.fn((noise: NoiseConfig) => {
    fake.reconcileNoise = noise
    syncExclusions()
  })
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
  fake.isScopeTargetExcluded = (p) => isUnderAny(p, fake.scopeExcludeDirs)
  fake.isReconcileTargetExcluded = (p) => isUnderAny(p, fake.reconcileExcludeDirs)
  fake.reconcile = vi.fn(async () => {})
  fake.sync = vi.fn(async () => ({
    ok: true,
    cancelled: false,
    summary: undefined,
    refusedFiles: [],
    refusedOverwriteFiles: [],
    error: undefined,
  }))
  fake.openedStateAmong = vi.fn(async () => new Map())
  fake.openedInTree = vi.fn(async () => ({ files: [], unknown: false }))
  fake.openedInTrees = vi.fn(async () => ({ files: [], unknown: false }))
  fake.revert = vi.fn(async () => {})
  fake.revertReconcile = vi.fn(async () => {})
  fake.changelistOf = vi.fn(() => undefined)
  fake.reconcileInto = vi.fn(async () => {})
  fake.reopen = vi.fn(async () => {})
  fake.driftGroupPaths = vi.fn(() => [] as string[])
  fake.pathsInChangelist = vi.fn(() => [] as string[])
  fake.newChangelist = vi.fn(async () => undefined as string | undefined)
  // The daily scope surface `activate` applies and the command layer gates on.
  // The gate's answer is DERIVED from this client's own exclusion predicates so
  // it cannot disagree with them: a fake that called everything "in range" would
  // silently skip the dialog the tests below are about (and the real client
  // never answers that way — see `checkScopeTargets`).
  fake.refreshScope = vi.fn(async () => 'ready')
  fake.setScopeNoticeHandler = vi.fn()
  fake.invalidateScope = vi.fn()
  fake.scopeState = 'ready'
  fake.scopeUnusableReason = undefined
  fake.dailyScope = undefined
  // The gate answers about the SCOPE layer alone: its question is "is this
  // inside the workspace range", and the reconcile noise is a separate setting
  // with its own gate. Reading the merged set here would put the noise's paths
  // in a dialog about the scope (and the real client derives this from the scope
  // config's own excludes — `scopeCoversTarget(base, target)`).
  fake.checkScopeTargets = vi.fn(
    async (targets: readonly { path: string; isDirectory: boolean }[]) => ({
      state: fake.scopeState,
      reason: fake.scopeUnusableReason,
      // What "obey the scope" narrows to: a target under an excluded directory is
      // not a part of the range, while a directory that merely CONTAINS one still
      // is (applying the exclusions inside it is what obeying means).
      inside: targets.filter((t) => !fake.isScopeTargetExcluded(t.path)),
      // The stricter question the dialog asks: anything an exclusion touches at
      // all, because what the user named in full is not what will run.
      outside: targets.filter(
        (t) => fake.isScopeTargetExcluded(t.path) || containsAny(t.path, fake.scopeExcludeDirs),
      ),
    }),
  )
  return fake
}

/** The scope's own exclusions (`.p4delta-scope`), as `refreshScope` would have
 *  resolved them. */
function setScopeExcludes(dirs: readonly string[], files: readonly string[] = []): void {
  fake.scopeExcludeDirs = dirs
  fake.scopeExcludeFiles = files
  syncExclusions()
}

/** `perforce.reconcile.excludeFolders`. */
function setNoise(dirs: readonly string[], files: readonly string[] = []): void {
  fake.reconcileNoise = { dirs, files }
  syncExclusions()
}

function syncExclusions(): void {
  fake.reconcileExcludeDirs = collapseScopeDirs([
    ...fake.scopeExcludeDirs,
    ...fake.reconcileNoise.dirs,
  ])
  fake.reconcileExcludeFiles = [
    ...fake.scopeExcludeFiles,
    ...fake.reconcileNoise.files.filter((file) => !isUnderAny(file, fake.reconcileExcludeDirs)),
  ]
}

function dir(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => true, isSymbolicLink: () => false }
}

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
  const handler = commandsMock.handlers.get(id)
  expect(handler, `command ${id} registered`).toBeDefined()
  await handler!(...args)
}

/** A fragment of the scope gate's own wording, which is how the three dialogs a
 *  gated operation can show are told apart. */
const SCOPE_GATE_MARKER = 'does not cover'
const NOISE_GATE_MARKER = 'reconcile exclusions hide'

/** Answer every dialog by KIND: the scope gate with `scope`, the noise gate with
 *  `noise`, anything else (the destructive confirm) with `confirm`.
 *
 * A gated operation shows the gates FIRST, and a single `mockResolvedValue` for
 * all of them would answer one gate with another's button — which turns the run
 * into a cancel, so the test would then silently assert "nothing happened" as
 * the expected outcome. */
function answerDialogs(scope: string | undefined, confirm?: string, noise?: string): void {
  windowMock.showWarningMessage.mockImplementation(async (message: string) => {
    const text = String(message)
    if (text.includes(SCOPE_GATE_MARKER)) return scope
    if (text.includes(NOISE_GATE_MARKER)) return noise
    return confirm
  })
}

/** The options a write ran under (argument 1 for the direct writes, argument 2
 *  for `reconcileInto(changelist, range, options)`). */
function writeOptions(mock: Mock, callIndex = 0, argIndex = 1): Record<string, unknown> {
  return (mock.mock.calls[callIndex]?.[argIndex] ?? {}) as Record<string, unknown>
}

/** The TARGETS a write was handed, read out of the range it was given (argument
 *  0 for the direct writes, argument 1 for `reconcileInto`). This layer never
 *  builds a filespec: the client derives the range at execution time from these
 *  raw typed targets and the rules in force then. */
function writeTargets(mock: Mock, callIndex = 0, argIndex = 0): unknown {
  return (mock.mock.calls[callIndex]?.[argIndex] as { targets?: unknown } | undefined)?.targets
}

let fake: FakeClient

beforeEach(async () => {
  fake = makeFakeClient()
  clientMock.state.current = fake
  commandsMock.handlers.clear()
  commandsMock.executeCommand.mockClear()
  commandsMock.executeCommand.mockResolvedValue(undefined)
  readdirMock.mockReset()
  readdirMock.mockImplementation(async () => {
    throw new Error('unexpected readdir')
  })
  windowMock.showInformationMessage.mockClear()
  windowMock.showWarningMessage.mockClear()
  windowMock.showWarningMessage.mockImplementation(
    async (_message: string, ..._items: string[]) => undefined as string | undefined,
  )
  windowMock.showErrorMessage.mockClear()
  windowMock.showErrorMessage.mockImplementation(async () => undefined as string | undefined)
  windowMock.showQuickPick.mockClear()
  windowMock.showInputBox.mockClear()
  windowMock.withProgress.mockClear()
  // Not cleared by `mockClear` (implementations survive): reinstall the default
  // answer so a case that made one config key non-empty cannot leak into the
  // ones after it.
  workspaceMock.get.mockImplementation(async (_key: string, def: unknown) => def)
  await activate({ subscriptions: [] } as never)
  expect(clientMock.create).toHaveBeenCalled()
})

describe('perforce.reconcile multi-select', () => {
  it('hands the raw typed targets over and lets the client derive the range', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    // This layer names the range and nothing else: no carve product is built
    // before the dialog, so none can go stale while it is up — the client builds
    // the filespecs at execution time, under the config in force then.
    expect(writeTargets(fake.reconcile)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('reports all-excluded and does not spawn when every target is excluded', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen'), SRC])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: posixJoin(ROOT, 'gen', 'a.txt'), isDirectory: false },
      { resourceUri: SRC, isDirectory: true },
    ])
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
  })
})

describe('perforce.reconcile single target', () => {
  it('hands a directory target over whole — the carve is not this layer’s job', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('hands a metacharacter target over RAW, with no escaping at this layer', async () => {
    // p4 filespec escaping happens once, at the p4 boundary of whichever engine
    // runs — pre-escaping here would make the engine look for `we%40ird#dir`.
    const weird = `${ROOT}/we@ird#dir`
    await runCommand('perforce.reconcile', { resourceUri: weird, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: weird, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })
})

describe('collect changes after a refused get', () => {
  const REFUSAL = {
    ok: false,
    cancelled: false,
    summary: undefined,
    refusedFiles: [],
    refusedOverwriteFiles: [],
    error: { kind: 'clobber', suggestion: "can't update modified file" },
  }

  function expectRefusalCollects(): void {
    fake.sync.mockResolvedValueOnce(REFUSAL)
    windowMock.showErrorMessage.mockResolvedValueOnce(BTN_COLLECT)
  }

  it('collects the selection scope over its raw targets', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    expectRefusalCollects()
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.syncLatest', { resourceUri: `${ROOT}/keep.txt` }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(writeTargets(fake.reconcile)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('collects a single directory target over its raw target', async () => {
    // The collect button is the one path that turns a refusal into a real p4
    // mutation, so the range must be the one the user confirmed — and only the
    // client can spell it, under the rules in force when it runs.
    setScopeExcludes([posixJoin(SRC, 'gen')])
    expectRefusalCollects()
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.syncLatest', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('passes a depot-syntax scope through untouched (scope branch)', async () => {
    // The graph's whole-repo `//...` (and the timeline's single depot file)
    // cannot be carved by local exclude dirs, so this branch must not even try.
    setScopeExcludes([posixJoin(SRC, 'gen')])
    expectRefusalCollects()
    await runCommand('perforce-graph.syncToChange', {
      change: '42',
      wholeRepo: true,
      confirmed: true,
    })
    expect(fake.reconcile).toHaveBeenCalledWith({ specs: ['//...'] })
  })

  it('collects the daily scope as TARGETS (no per-call scope branch)', async () => {
    // A scope-less get is bounded by the daily scope, so that is what its
    // refusal must offer to collect — here one included directory with an
    // excluded subtree inside it, i.e. exactly the carve case.
    fake.dailyScope = scopeView([ROOT], [posixJoin(ROOT, 'gen')])
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(writeTargets(fake.reconcile)).toEqual([{ path: ROOT, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('hands an all-excluded daily scope over as its targets, leaving the verdict to the client', async () => {
    // `scopeTargets` keeps the INCLUDE verbatim (a view whose include is also
    // excluded is one no resolution would collapse for the caller), so this
    // layer must not try to out-guess it: the range check and the "everything is
    // excluded" answer belong to the write entry, which reads the rules that are
    // in force when it actually runs.
    fake.dailyScope = scopeView([ROOT], [ROOT])
    setScopeExcludes([ROOT])
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(writeTargets(fake.reconcile)).toEqual([{ path: ROOT, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('collects the configured filespec scope verbatim when no daily scope resolved', async () => {
    // With no resolved daily scope the client's own default range is the only
    // thing a scope-less get could have run over — and when it is a depot spec
    // (`//...`), that spec must still be collected, not reported as an empty
    // carve.
    fake.syncScopeDirs = []
    fake.syncScopes = ['//...']
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(fake.reconcile).toHaveBeenCalledWith({ specs: ['//...'] })
    expect(windowMock.showInformationMessage).not.toHaveBeenCalled()
  })

  it('refuses to collect the workspace root when the daily scope is unusable', async () => {
    // With the scope unresolved, `syncScopes` is the whole client root — the
    // exact range whose exclusions are unknown — so collecting it would open
    // files the scope shields (the config file above all) on behalf of a range
    // the editor cannot vouch for.
    fake.scopeState = 'blocked'
    fake.scopeUnusableReason = 'the scope report did not produce a usable answer'
    fake.syncScopeDirs = [ROOT]
    fake.syncScopes = [`${ROOT}/...`]
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
    const message = String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(message).toContain('the scope report did not produce a usable answer')
  })
})

describe('perforce.revert clean gating', () => {
  it('asks before a clean that reaches outside the scope, and does nothing on cancel', async () => {
    // The clean half discards uncollected work over a range the user NAMED, so
    // it takes the same gate the collect half takes. The silent exclusion filter
    // this replaces could promise one range in the confirm and run another.
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), 'default']]))
    answerDialogs(undefined)
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    // The gate comes first and names the target it would have discarded
    // silently. The clean is off — but `p4 revert` is about files the user
    // already sees open, so the revert half asks its own confirm, which the same
    // dismissal answers.
    const gate = String(windowMock.showWarningMessage.mock.calls[0]?.[0] ?? '')
    expect(gate).toContain(posixJoin(ROOT, 'gen', 'b.txt'))
    expect(windowMock.showWarningMessage).toHaveBeenCalledTimes(2)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('obeying the scope drops the excluded file and discards the rest', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), 'default']]))
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/a.txt`])
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('reports "nothing in scope" instead of discarding when obeying leaves nothing', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.revert', { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') }, [
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('runs the excluded file as chosen, with the override the client needs', async () => {
    // "Run as chosen" is the ONE path past the scope, and it has to reach the
    // client as an override: the client's own native branch refuses a target the
    // scope does not cover, so an override that stopped at this layer would turn
    // the user's explicit answer into a refusal.
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), 'default']]))
    answerDialogs(BTN_RUN, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/a.txt`])
    expect(writeTargets(fake.revertReconcile)).toEqual([
      { path: posixJoin(ROOT, 'gen', 'b.txt'), isDirectory: false },
    ])
    expect(writeOptions(fake.revertReconcile)).toEqual({ overrideScope: true })
  })

  it('hands the clean the directory target and leaves revert as dir/...', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(fake.revert).toHaveBeenCalledWith([`${SRC}/...`])
    expect(writeTargets(fake.revertReconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
  })

  it('stops the whole operation when obeying leaves an excluded directory with nothing', async () => {
    // Both halves are one operation: a confirm that promised to discard
    // uncollected work must not silently keep it, and a user who just answered
    // "use the workspace scope" for a directory the scope excludes asked for
    // nothing to run.
    setScopeExcludes([SRC])
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('reverts the whole directory as chosen, and still carries the NOISE into the clean', async () => {
    // "Run as chosen" sets the SCOPE aside for this call; the reconcile
    // exclusions are a different setting and were never part of that answer, so
    // the operation still carries them and the client still carves around them.
    setScopeExcludes([SRC])
    setNoise([posixJoin(SRC, 'gen')])
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    answerDialogs(BTN_RUN, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(fake.revert).toHaveBeenCalledWith([`${SRC}/...`])
    expect(writeTargets(fake.revertReconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.revertReconcile)).toEqual({ overrideScope: true })
  })

  it('drops the discard-unopened promise from the confirm when obeying removed them', async () => {
    // The narrowing runs before the dialog on purpose: promising to discard
    // uncollected work and then keeping it is the one thing a destructive
    // confirm must never do.
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${SRC}/opened.ts`), '5']]))
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: `${SRC}/opened.ts` }, [
      { resourceUri: `${SRC}/opened.ts` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    const confirm = String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(confirm).toContain(
      localize(
        'perforce.revert.leaveClHeader',
        'These files will leave their changelist. Local changes will be lost.',
      ),
    )
    expect(confirm).not.toContain(
      localize(
        'perforce.revert.alsoUnopened',
        'Working-tree changes on {0} unopened file(s) will also be discarded.',
        { 0: '1' },
      ),
    )
  })

  it('counts only the surviving unopened files in the confirm', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), 'default']]))
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    const confirm = String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(confirm).toContain('a.txt')
    expect(confirm).not.toContain('b.txt')
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/a.txt`])
  })

  it('never confirms when exclusions leave nothing to revert or clean', async () => {
    setScopeExcludes([SRC])
    fake.openedInTree.mockResolvedValueOnce({ files: [], unknown: false })
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    // The only dialog is the scope gate — the destructive confirm never ran,
    // because there is nothing left to promise about.
    expect(windowMock.showWarningMessage).toHaveBeenCalledTimes(1)
    expect(String(windowMock.showWarningMessage.mock.calls[0]?.[0] ?? '')).toContain(
      SCOPE_GATE_MARKER,
    )
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })
})

/** The noise layer is a SETTING, not a range: it prunes what the machinery walks
 *  over (a batch target that merely CONTAINS a noise folder), and a target it
 *  actually covers is put to the user — the explicit answer then lifts the rule
 *  for that target alone. */
describe('reconcile noise (perforce.reconcile.excludeFolders)', () => {
  const GEN = posixJoin(SRC, 'gen')

  it('passes a target that merely CONTAINS a noise folder through, with no prompt', async () => {
    setNoise([GEN])
    await runCommand('perforce.reconcile', { resourceUri: SRC, isDirectory: true })
    // The folder inside is the CLIENT's business (the carve prunes it from the
    // walk, or the engine applies the rule inside its own call), and no dialog
    // is owed: selecting a parent is a batch, and batch defaults are pruned
    // silently.
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(windowMock.showWarningMessage).not.toHaveBeenCalled()
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('asks before a collect that names a noise folder, and writes nothing on cancel', async () => {
    setNoise([GEN])
    answerDialogs(undefined, undefined, undefined)
    await runCommand('perforce.reconcile', { resourceUri: GEN, isDirectory: true })
    const gate = String(windowMock.showWarningMessage.mock.calls[0]?.[0] ?? '')
    expect(gate).toContain(NOISE_GATE_MARKER)
    expect(gate).toContain(GEN)
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('lifts the rule for the confirmed target ALONE, never for the batch around it', async () => {
    setNoise([GEN])
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    // The user names both the parent and the noise folder inside it and answers
    // "run as chosen": the confirmation is about the folder they named, so the
    // parent keeps walking around it.
    answerDialogs(BTN_OBEY, undefined, BTN_RUN)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: GEN, isDirectory: true },
    ])
    expect(fake.reconcile).toHaveBeenCalledTimes(2)
    expect(writeTargets(fake.reconcile, 0)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.reconcile, 0)).toEqual({})
    // The confirmed operation carries the user's AUTHORIZATION — the target they
    // named, and only that — and no copy of the rules: those are read at the
    // write, so a rule that appears meanwhile still shields what they did not
    // name.
    expect(writeTargets(fake.reconcile, 1)).toEqual([{ path: GEN, isDirectory: true }])
    expect(writeOptions(fake.reconcile, 1)).toEqual({
      confirmedTargets: [{ path: GEN, isDirectory: true }],
    })
  })

  it('"skip them" drops the covered target and still collects the rest', async () => {
    setNoise([GEN])
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    answerDialogs(BTN_OBEY, undefined, BTN_SKIP)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: GEN, isDirectory: true },
    ])
    expect(fake.reconcile).toHaveBeenCalledTimes(1)
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('carries the user’s authorization — never a frozen reading of the rules — across the gate', async () => {
    setNoise([GEN])
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    // The dialog is a gap long enough for a settings edit. What crosses it is the
    // answer the user gave (the target they named), never the rule set the dialog
    // happened to be showing: the client reads the rules again at the write, so a
    // rule that appears meanwhile applies, and the rule lifted for the named
    // target is lifted against the rules in force then.
    windowMock.showWarningMessage.mockImplementation(async (message: string) => {
      if (String(message).includes(SCOPE_GATE_MARKER)) return BTN_OBEY
      setNoise([posixJoin(SRC, 'other')])
      return BTN_RUN
    })
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: GEN, isDirectory: true },
    ])
    expect(writeOptions(fake.reconcile, 0)).toEqual({})
    expect(writeOptions(fake.reconcile, 1)).toEqual({
      confirmedTargets: [{ path: GEN, isDirectory: true }],
    })
  })

  it('a noise rule added while the destructive confirm is up reaches the clean', async () => {
    setNoise([])
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    answerDialogs(BTN_OBEY, BTN_REVERT)
    // The destructive confirm is the moment the setting gains a rule. The clean's
    // filespecs are derived at the WRITE, so this rule shields its subtree —
    // handing the client the rule set read before the dialog instead (the shape
    // this used to have, with the stale copy winning) is how `p4 clean -a` ended
    // up deleting inside a folder the user had just excluded.
    windowMock.showWarningMessage.mockImplementation(async (message: string) => {
      const text = String(message)
      if (text.includes(SCOPE_GATE_MARKER)) return BTN_OBEY
      setNoise([GEN])
      return BTN_REVERT
    })
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.revertReconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
  })

  it('narrows the clean on "skip them": the confirm cannot promise what the run drops', async () => {
    setNoise([GEN])
    fake.openedStateAmong.mockResolvedValueOnce(new Map())
    answerDialogs(BTN_OBEY, BTN_REVERT, BTN_SKIP)
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(GEN, 'b.txt') },
    ])
    expect(writeTargets(fake.revertReconcile)).toEqual([
      { path: `${ROOT}/a.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
    const confirm = String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(confirm).toContain('a.txt')
    expect(confirm).not.toContain('b.txt')
  })

  it('lifts a FILE rule for the confirmed target so the native gate lets it through', async () => {
    // The native gate refuses a target the rules hide, and it reads the
    // OPERATION's own exclusions: re-applying a rule the user just confirmed
    // through would turn their answer into a refusal. Its sibling in the same
    // batch keeps the rule — the plans are per operation.
    const hidden = posixJoin(GEN, '.p4delta-scope')
    setNoise([], [hidden])
    answerDialogs(BTN_OBEY, undefined, BTN_RUN)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: hidden, isDirectory: false },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    // The confirmed target ran (its rule lifted), the sibling ran unaffected
    // (the rule never covered it).
    expect(fake.reconcile).toHaveBeenCalledTimes(2)
    expect(writeTargets(fake.reconcile, 0)).toEqual([
      { path: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcile, 0)).toEqual({})
    expect(writeTargets(fake.reconcile, 1)).toEqual([{ path: hidden, isDirectory: false }])
    expect(writeOptions(fake.reconcile, 1)).toEqual({
      confirmedTargets: [{ path: hidden, isDirectory: false }],
    })
  })
})

describe('the explicit-target scope dialog', () => {
  function outsideOnce(): void {
    fake.checkScopeTargets.mockResolvedValueOnce({
      state: 'ready',
      reason: undefined,
      inside: [{ path: SRC, isDirectory: true }],
      outside: [{ path: `${ROOT}/outside`, isDirectory: true }],
    })
  }

  it('runs the named targets unchanged when the user chooses "run as chosen"', async () => {
    outsideOnce()
    windowMock.showWarningMessage.mockResolvedValue(BTN_RUN)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/outside`, isDirectory: true },
    ])
    expect(writeTargets(fake.reconcile)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${ROOT}/outside`, isDirectory: true },
    ])
    expect(writeOptions(fake.reconcile)).toEqual({ overrideScope: true })
  })

  it('reports "nothing in scope" instead of running when obeying leaves no target', async () => {
    fake.checkScopeTargets.mockResolvedValueOnce({
      state: 'ready',
      reason: undefined,
      inside: [],
      outside: [{ path: `${ROOT}/outside`, isDirectory: true }],
    })
    windowMock.showWarningMessage.mockResolvedValue(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: `${ROOT}/outside`, isDirectory: true },
    ])
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
  })

  it('refuses the operation when the scope is not usable, naming the reason', async () => {
    fake.checkScopeTargets.mockResolvedValueOnce({
      state: 'blocked',
      reason: 'the scope report did not produce a usable answer',
      inside: [],
      outside: [{ path: SRC, isDirectory: true }],
    })
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
    ])
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
    const message = String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')
    expect(message).toContain('the scope report did not produce a usable answer')
  })
})

/** Every write point hands over the RAW targets it was given — never a filespec
 *  list, and never a carve product. Which engine runs, and what shape the range
 *  takes for it, is decided inside the client's write entry on the same reading
 *  of the same state; the "everything excluded" answer stays this layer's. */
describe('every write point hands over raw targets', () => {
  const REFUSAL = {
    ok: false,
    cancelled: false,
    summary: undefined,
    refusedFiles: [],
    refusedOverwriteFiles: [],
    error: { kind: 'clobber', suggestion: "can't update modified file" },
  }

  it('multi-select: the named targets, excluded entries dropped, nothing carved', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: posixJoin(SRC, 'gen', 'skip.txt'), isDirectory: false },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    // An entry wholly inside an exclusion is dropped by the gate (neither engine
    // may collect it) and the rest travels as the raw targets. Should the engine
    // run change mid-flight, the client re-derives the range from THESE targets
    // and refuses a shape native p4 cannot be trusted with — this layer has no
    // verdict of its own to be stale.
    expect(writeTargets(fake.reconcile)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('multi-select: still reports all-excluded without spawning', async () => {
    setScopeExcludes([SRC])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
    ])
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.reconcile).not.toHaveBeenCalled()
  })

  it('single directory target: the target itself, not a carve around the excluded subtree', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('collect-after-refusal passes the same targets through', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    fake.sync.mockResolvedValueOnce(REFUSAL)
    windowMock.showErrorMessage.mockResolvedValueOnce(BTN_COLLECT)
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.syncLatest', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: SRC, isDirectory: true }])
  })

  it('revert hands clean the whole directory instead of a carve', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    fake.openedInTree.mockResolvedValueOnce({ files: [], unknown: false })
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(writeTargets(fake.revertReconcile)).toEqual([{ path: SRC, isDirectory: true }])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
  })
})

/** A path holding a p4 filespec metacharacter travels RAW like any other: this
 *  layer never escapes, and never diverts such a target to a special path. The
 *  escaping happens once, at the p4 boundary of whichever engine runs. */
describe('paths with p4 metacharacters', () => {
  const WEIRD = `${ROOT}/50%_stuff`

  it('multi-select: the metacharacter target travels raw, with its siblings', async () => {
    setScopeExcludes([posixJoin(WEIRD, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: WEIRD, isDirectory: true },
      { resourceUri: `${ROOT}/plain`, isDirectory: true },
    ])
    expect(writeTargets(fake.reconcile)).toEqual([
      { path: WEIRD, isDirectory: true },
      { path: `${ROOT}/plain`, isDirectory: true },
    ])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('single directory target: the raw path, no escaping at this layer', async () => {
    setScopeExcludes([posixJoin(WEIRD, 'gen')])
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.reconcile', { resourceUri: WEIRD, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: WEIRD, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('collect-after-refusal: a metacharacter target passes through', async () => {
    setScopeExcludes([posixJoin(WEIRD, 'gen')])
    fake.sync.mockResolvedValueOnce({
      ok: false,
      cancelled: false,
      summary: undefined,
      refusedFiles: [],
      refusedOverwriteFiles: [],
      error: { kind: 'clobber', suggestion: "can't update modified file" },
    })
    windowMock.showErrorMessage.mockResolvedValueOnce(BTN_COLLECT)
    answerDialogs(BTN_OBEY)
    await runCommand('perforce.syncLatest', { resourceUri: WEIRD, isDirectory: true })
    expect(writeTargets(fake.reconcile)).toEqual([{ path: WEIRD, isDirectory: true }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('revert: a metacharacter directory is handed to clean whole', async () => {
    setScopeExcludes([posixJoin(WEIRD, 'gen')])
    fake.openedInTree.mockResolvedValueOnce({ files: [], unknown: false })
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: WEIRD, isDirectory: true })
    expect(writeTargets(fake.revertReconcile)).toEqual([{ path: WEIRD, isDirectory: true }])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
  })

  it('revert: a file target with a metacharacter stays raw too', async () => {
    setScopeExcludes([posixJoin(SRC, 'gen')])
    fake.openedStateAmong.mockResolvedValueOnce(new Map())
    fake.openedInTrees.mockResolvedValueOnce({ files: [], unknown: false })
    answerDialogs(BTN_OBEY, BTN_REVERT)
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/we@ird.txt` },
    ])
    expect(writeTargets(fake.revertReconcile)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${ROOT}/we@ird.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.revertReconcile)).toEqual({})
  })
})

describe('perforce.reopenTo exclusion gating', () => {
  it('drops scope-excluded uncollected files from reconcileInto', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(writeTargets(fake.reconcileInto, 0, 1)).toEqual([
      { path: `${ROOT}/a.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcileInto, 0, 2)).toEqual({})
    expect(fake.reopen).not.toHaveBeenCalled()
  })

  it('still reopens opened files even under an excluded directory', async () => {
    setScopeExcludes([posixJoin(ROOT, 'gen')])
    fake.changelistOf.mockImplementation((p: string) =>
      p === posixJoin(ROOT, 'gen', 'b.txt') ? '7' : undefined,
    )
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(writeTargets(fake.reconcileInto, 0, 1)).toEqual([
      { path: `${ROOT}/a.txt`, isDirectory: false },
    ])
    expect(fake.reopen).toHaveBeenCalledWith('5', [posixJoin(ROOT, 'gen', 'b.txt')])
  })

  it('asks about a NOISE-covered uncollected file instead of dropping it', async () => {
    setNoise([posixJoin(ROOT, 'gen')])
    answerDialogs(undefined, undefined, BTN_RUN)
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    // Dropping it silently is what a batch default may do for discovery rows;
    // a path the user dragged onto a changelist is their own selection. The
    // answer then runs as two calls — the confirmed target carrying the user's
    // authorization, its sibling none — because one `reconcile -c` call carries
    // one authorization (the rules themselves are read at each write).
    expect(fake.reconcileInto).toHaveBeenCalledTimes(2)
    expect(writeTargets(fake.reconcileInto, 0, 1)).toEqual([
      { path: `${ROOT}/a.txt`, isDirectory: false },
    ])
    expect(writeOptions(fake.reconcileInto, 0, 2)).toEqual({})
    expect(writeTargets(fake.reconcileInto, 1, 1)).toEqual([
      { path: posixJoin(ROOT, 'gen', 'b.txt'), isDirectory: false },
    ])
    expect(writeOptions(fake.reconcileInto, 1, 2)).toEqual({
      confirmedTargets: [{ path: posixJoin(ROOT, 'gen', 'b.txt'), isDirectory: false }],
    })
  })

  it('writes nothing for the uncollected half when the noise gate is cancelled, and still reopens', async () => {
    setNoise([posixJoin(ROOT, 'gen')])
    fake.changelistOf.mockImplementation((p: string) => (p === `${ROOT}/a.txt` ? '7' : undefined))
    answerDialogs(undefined, undefined, undefined)
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: posixJoin(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.reconcileInto).not.toHaveBeenCalled()
    // Opened files are not the noise's business: `reopen` keeps its full
    // semantics whether or not the collect half ran.
    expect(fake.reopen).toHaveBeenCalledWith('5', [`${ROOT}/a.txt`])
  })
})

/** Group-header invocations carry `{rootUri, sourceControlId, scmResourceGroupId}`
 *  and NO resourceUri / selection. The handlers must fan out over the group's
 *  own rows — and must NOT hijack file rows in the same group (those DO carry a
 *  resourceUri). */
describe('group-header fan-out', () => {
  const GROUP_ARG = { rootUri: ROOT, sourceControlId: 'perforce', scmResourceGroupId: 'reconcile' }
  const DRIFT = [`${ROOT}/a.txt`, `${ROOT}/dir/b.txt`]
  const DRIFT_TARGETS = DRIFT.map((path) => ({ path, isDirectory: false }))

  it('perforce.reconcile collects every drift path the group shows', async () => {
    fake.driftGroupPaths.mockReturnValue(DRIFT)
    await runCommand('perforce.reconcile', GROUP_ARG)
    expect(fake.driftGroupPaths).toHaveBeenCalled()
    expect(writeTargets(fake.reconcile)).toEqual(DRIFT_TARGETS)
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('perforce.reconcile on a file row in the reconcile group stays per-file', async () => {
    // Regression: the group branch must not swallow file rows, which carry a
    // resourceUri even though their scmResourceGroupId is also 'reconcile'.
    await runCommand('perforce.reconcile', { resourceUri: `${ROOT}/a.txt` })
    expect(fake.driftGroupPaths).not.toHaveBeenCalled()
    expect(writeTargets(fake.reconcile)).toEqual([{ path: `${ROOT}/a.txt`, isDirectory: false }])
    expect(writeOptions(fake.reconcile)).toEqual({})
  })

  it('perforce.reconcileIntoNewChangelist collects every drift path into the new changelist', async () => {
    fake.driftGroupPaths.mockReturnValue(DRIFT)
    windowMock.showInputBox.mockResolvedValueOnce('my new changelist')
    fake.newChangelist.mockResolvedValueOnce('42')
    await runCommand('perforce.reconcileIntoNewChangelist', GROUP_ARG)
    expect(fake.newChangelist).toHaveBeenCalledWith('my new changelist')
    expect(writeTargets(fake.reconcileInto, 0, 1)).toEqual(DRIFT_TARGETS)
    expect(writeOptions(fake.reconcileInto, 0, 2)).toEqual({})
  })

  it('perforce.reconcileIntoNewChangelist does nothing when the description is cancelled', async () => {
    fake.driftGroupPaths.mockReturnValue(DRIFT)
    windowMock.showInputBox.mockResolvedValueOnce(undefined)
    await runCommand('perforce.reconcileIntoNewChangelist', GROUP_ARG)
    expect(fake.newChangelist).not.toHaveBeenCalled()
    expect(fake.reconcileInto).not.toHaveBeenCalled()
  })

  it('perforce.revert on the reconcile group header discards via clean only', async () => {
    fake.driftGroupPaths.mockReturnValue(DRIFT)
    windowMock.showWarningMessage.mockResolvedValue(BTN_REVERT)
    await runCommand('perforce.revert', GROUP_ARG)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(writeTargets(fake.revertReconcile)).toEqual(DRIFT_TARGETS)
    expect(writeOptions(fake.revertReconcile)).toEqual({})
    const message = windowMock.showWarningMessage.mock.calls[0]?.[0] ?? ''
    expect(message).toContain(
      localize(
        'perforce.revert.discardMany',
        'Discard working-tree changes for {0} files? This cannot be undone.',
        { 0: String(DRIFT.length) },
      ),
    )
  })

  it('perforce.revert on a changelist group header reverts its own files (not the active editor)', async () => {
    // Regression: the group branch used to fall back to the active editor's
    // file via resolveTargetPaths, reverting an unrelated path.
    fake.pathsInChangelist.mockReturnValue([`${ROOT}/opened.txt`])
    windowMock.showWarningMessage.mockResolvedValue(BTN_REVERT)
    await runCommand('perforce.revert', {
      rootUri: ROOT,
      sourceControlId: 'perforce',
      scmResourceGroupId: 'cl:7',
    })
    expect(fake.pathsInChangelist).toHaveBeenCalledWith('7')
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/opened.txt`])
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('perforce.revert on a default changelist group header reverts the default files', async () => {
    fake.pathsInChangelist.mockReturnValue([`${ROOT}/d1.txt`, `${ROOT}/d2.txt`])
    windowMock.showWarningMessage.mockResolvedValue(BTN_REVERT)
    await runCommand('perforce.revert', {
      rootUri: ROOT,
      sourceControlId: 'perforce',
      scmResourceGroupId: 'default',
    })
    expect(fake.pathsInChangelist).toHaveBeenCalledWith('default')
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/d1.txt`, `${ROOT}/d2.txt`])
  })

  it('perforce.revert on a file row in a changelist group stays per-file', async () => {
    // Regression: the group-header fix must not hijack file rows, which carry a
    // resourceUri alongside their scmResourceGroupId.
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), '3']]))
    windowMock.showWarningMessage.mockResolvedValue(BTN_REVERT)
    await runCommand('perforce.revert', {
      resourceUri: `${ROOT}/a.txt`,
      scmResourceGroupId: 'cl:3',
    })
    expect(fake.pathsInChangelist).not.toHaveBeenCalled()
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/a.txt`])
  })
})
