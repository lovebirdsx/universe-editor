/**
 * Command-layer gate tests for `perforce.reconcile.excludeFolders`: drive the
 * real handlers captured from `activate()` — the only place that wires carve
 * results to toasts and p4 calls — with a fake client whose exclusion
 * predicates are the real `pathUtil` ones, and a mocked `readdir` for the
 * carve walks. Locks in:
 *  1. Multi-select reconcile carves excluded subtrees, warns about unreadable
 *     directories without aborting, and reports all-excluded without spawning.
 *  2. Single-target reconcile carves / aborts on carve failure / escapes
 *     filespec metacharacters (never a bare `${dir}/...`).
 *  3. The collect-after-refusal remedy's three branches: carved selection
 *     scope, untouched filespec scope, carved default sync-scope dirs.
 *  4. Revert gates `p4 clean` only (file filter / directory carve / carve
 *     failure skip / excluded skip) while `p4 revert` stays unfiltered.
 *  5. reopenTo drops excluded uncollected files but still reopens opened ones.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { containsAny, isUnderAny, norm } from '../pathUtil.js'
import { localize } from '../nls.js'

const ROOT = vi.hoisted(() => 'X:/p4ws/main')
const SRC = `${ROOT}/src`

const ALL_EXCLUDED = localize(
  'perforce.reconcile.allExcluded',
  'The selected paths are excluded by perforce.reconcile.excludeFolders.',
)
const CARVE_FAILED = localize(
  'perforce.reconcile.carveFailed',
  'Some directories could not be read, so files under them were skipped.',
)
const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
const BTN_COLLECT = localize('perforce.btn.collectChanges', 'Collect Changes')

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
  showInputBox: vi.fn(async () => undefined),
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

import { activate } from '../extension.js'

type Mock = ReturnType<typeof vi.fn>

interface FakeClient {
  root: string
  clientName: string
  user: string
  syncScopeDirs: readonly string[]
  syncScopes: readonly string[]
  reconcileExcludeDirs: readonly string[]
  refresh: Mock
  startPolling: Mock
  setSwarmAvailable: Mock
  setReconcileScope: Mock
  setReconcileScanOptions: Mock
  setOpenedByOthersOptions: Mock
  setSyncScope: Mock
  setReconcileExcludes: Mock
  dispose: Mock
  cancelBusy: Mock
  isReconcileTargetExcluded(path: string): boolean
  containsAnyReconcileExclude(dir: string): boolean
  reconcile: Mock
  sync: Mock
  openedStateAmong: Mock
  openedInTree: Mock
  revert: Mock
  revertReconcile: Mock
  changelistOf: Mock
  reconcileInto: Mock
  reopen: Mock
}

/** A client whose exclusion predicates are the real pathUtil ones, fed by
 *  `reconcileExcludeDirs` (what `applyReconcileExcludes` would have set). */
function makeFakeClient(): FakeClient {
  const fake = {} as FakeClient
  fake.root = ROOT
  fake.clientName = 'testclient'
  fake.user = 'testuser'
  fake.syncScopeDirs = [ROOT]
  fake.syncScopes = [`${ROOT}/...`]
  fake.reconcileExcludeDirs = []
  fake.refresh = vi.fn(async () => {})
  fake.startPolling = vi.fn()
  fake.setSwarmAvailable = vi.fn()
  fake.setReconcileScope = vi.fn()
  fake.setReconcileScanOptions = vi.fn()
  fake.setOpenedByOthersOptions = vi.fn()
  fake.setSyncScope = vi.fn((dirs: readonly string[] | string) => {
    fake.syncScopeDirs = typeof dirs === 'string' ? [dirs] : [...dirs]
    fake.syncScopes = fake.syncScopeDirs.map((d) => `${d}/...`)
  })
  fake.setReconcileExcludes = vi.fn((dirs: readonly string[]) => {
    fake.reconcileExcludeDirs = [...dirs]
  })
  fake.dispose = vi.fn()
  fake.cancelBusy = vi.fn()
  fake.isReconcileTargetExcluded = (p) => isUnderAny(p, fake.reconcileExcludeDirs)
  fake.containsAnyReconcileExclude = (d) => containsAny(d, fake.reconcileExcludeDirs)
  fake.reconcile = vi.fn(async () => {})
  fake.sync = vi.fn(async () => ({
    ok: true,
    cancelled: false,
    summary: undefined,
    refusedFiles: [],
    error: undefined,
  }))
  fake.openedStateAmong = vi.fn(async () => new Map())
  fake.openedInTree = vi.fn(async () => ({ files: [], unknown: false }))
  fake.revert = vi.fn(async () => {})
  fake.revertReconcile = vi.fn(async () => {})
  fake.changelistOf = vi.fn(() => undefined)
  fake.reconcileInto = vi.fn(async () => {})
  fake.reopen = vi.fn(async () => {})
  return fake
}

function file(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => false, isSymbolicLink: () => false }
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
  windowMock.showErrorMessage.mockClear()
  windowMock.showQuickPick.mockClear()
  windowMock.showInputBox.mockClear()
  windowMock.withProgress.mockClear()
  await activate({ subscriptions: [] } as never)
  expect(clientMock.create).toHaveBeenCalled()
})

describe('perforce.reconcile multi-select', () => {
  it('carves excluded subtrees out of directory targets and collects the rest', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('sibling'), file('a.txt')]
      throw new Error('unexpected readdir')
    })
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(fake.reconcile).toHaveBeenCalledWith([
      `${SRC}/*`,
      `${join(SRC, 'sibling')}/...`,
      `${ROOT}/keep.txt`,
    ])
  })

  it('warns about unreadable directories and still collects the remaining specs', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen'), join(ROOT, 'broken', 'deep')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), file('a.txt')]
      throw new Error('EACCES')
    })
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: join(ROOT, 'broken'), isDirectory: true },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(windowMock.showWarningMessage).toHaveBeenCalledWith(CARVE_FAILED)
    expect(windowMock.showInformationMessage).not.toHaveBeenCalled()
    expect(fake.reconcile).toHaveBeenCalledWith([`${SRC}/*`, `${ROOT}/keep.txt`])
  })

  it('reports all-excluded and does not spawn when every target is excluded', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen'), SRC]
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: join(ROOT, 'gen', 'a.txt'), isDirectory: false },
      { resourceUri: SRC, isDirectory: true },
    ])
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.reconcile).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('does not claim all-excluded when the carve failed on every target', async () => {
    // Blaming the config for a read failure would send the user to the wrong
    // setting; the carve warning is the only honest answer here.
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    readdirMock.mockImplementation(async () => {
      throw new Error('EACCES')
    })
    await runCommand('perforce.reconcile', { isDirectory: false }, [
      { resourceUri: SRC, isDirectory: true },
    ])
    expect(windowMock.showWarningMessage).toHaveBeenCalledWith(CARVE_FAILED)
    expect(windowMock.showInformationMessage).not.toHaveBeenCalled()
    expect(fake.reconcile).not.toHaveBeenCalled()
  })
})

describe('perforce.reconcile single target', () => {
  it('carves a directory that contains an excluded subtree', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    await runCommand('perforce.reconcile', { resourceUri: SRC, isDirectory: true })
    expect(fake.reconcile).toHaveBeenCalledWith([`${SRC}/*`, `${join(SRC, 'ok')}/...`])
  })

  it('aborts with a warning when the carve fails, without spawning', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    await runCommand('perforce.reconcile', { resourceUri: SRC, isDirectory: true })
    expect(windowMock.showWarningMessage).toHaveBeenCalledWith(CARVE_FAILED)
    expect(fake.reconcile).not.toHaveBeenCalled()
  })

  it('escapes filespec metacharacters on a clean directory target', async () => {
    const weird = `${ROOT}/we@ird#dir`
    await runCommand('perforce.reconcile', { resourceUri: weird, isDirectory: true })
    expect(fake.reconcile).toHaveBeenCalledWith([`${ROOT}/we%40ird%23dir/...`])
  })
})

describe('collect changes after a refused get', () => {
  const REFUSAL = {
    ok: false,
    cancelled: false,
    summary: undefined,
    refusedFiles: [],
    error: { kind: 'clobber', suggestion: "can't update modified file" },
  }

  function expectRefusalCollects(): void {
    fake.sync.mockResolvedValueOnce(REFUSAL)
    windowMock.showErrorMessage.mockResolvedValueOnce(BTN_COLLECT)
  }

  it('carves the selection scope (scopeTargets branch)', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    expectRefusalCollects()
    await runCommand('perforce.syncLatest', { resourceUri: `${ROOT}/keep.txt` }, [
      { resourceUri: SRC, isDirectory: true },
      { resourceUri: `${ROOT}/keep.txt`, isDirectory: false },
    ])
    expect(fake.reconcile).toHaveBeenCalledWith([
      `${SRC}/*`,
      `${join(SRC, 'ok')}/...`,
      `${ROOT}/keep.txt`,
    ])
  })

  it('carves a single directory target (scopeTargets branch)', async () => {
    // A single-target get on a local directory must carve too: the collect
    // button is the one path that turns a refusal into a real p4 mutation.
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    expectRefusalCollects()
    await runCommand('perforce.syncLatest', { resourceUri: SRC, isDirectory: true })
    expect(fake.reconcile).toHaveBeenCalledWith([`${SRC}/*`, `${join(SRC, 'ok')}/...`])
  })

  it('passes a depot-syntax scope through untouched (scope branch)', async () => {
    // The graph's whole-repo `//...` (and the timeline's single depot file)
    // cannot be carved by local exclude dirs, so this branch must not even try.
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    expectRefusalCollects()
    await runCommand('perforce-graph.syncToChange', {
      change: '42',
      wholeRepo: true,
      confirmed: true,
    })
    expect(fake.reconcile).toHaveBeenCalledWith(['//...'])
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('carves the default sync-scope dirs (syncScopeDirs branch)', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [dir('gen'), dir('src'), file('keep.txt')]
      throw new Error('unexpected readdir')
    })
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(fake.reconcile).toHaveBeenCalledWith([`${ROOT}/*`, `${join(ROOT, 'src')}/...`])
  })

  it('reports all-excluded without spawning when the whole default scope is excluded', async () => {
    fake.reconcileExcludeDirs = [ROOT]
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.reconcile).not.toHaveBeenCalled()
  })

  it('collects the default filespec scope verbatim when no scope dirs are configured', async () => {
    // `syncScopeDirs` stays empty until a scope is configured while
    // `syncScopes` already defaults to `//...` — that depot spec must still be
    // collected, not reported as an empty carve.
    fake.syncScopeDirs = []
    fake.syncScopes = ['//...']
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    expectRefusalCollects()
    await runCommand('perforce.syncLatest')
    expect(fake.reconcile).toHaveBeenCalledWith(['//...'])
    expect(windowMock.showInformationMessage).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
  })
})

describe('perforce.revert clean gating', () => {
  function expectConfirmRevert(): void {
    windowMock.showWarningMessage.mockResolvedValue(BTN_REVERT)
  }

  it('filters excluded files out of clean and keeps revert untouched', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    fake.openedStateAmong.mockResolvedValueOnce(new Map([[norm(`${ROOT}/a.txt`), 'default']]))
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: join(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.revert).toHaveBeenCalledWith([`${ROOT}/a.txt`])
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('carves the directory clean spec and leaves revert as dir/...', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    readdirMock.mockImplementation(async (d: string) => {
      if (d === SRC) return [dir('gen'), dir('ok')]
      throw new Error('unexpected readdir')
    })
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(fake.revert).toHaveBeenCalledWith([`${SRC}/...`])
    expect(fake.revertReconcile).toHaveBeenCalledWith([`${SRC}/*`, `${join(SRC, 'ok')}/...`])
  })

  it('skips clean when the directory carve fails but still reverts', async () => {
    fake.reconcileExcludeDirs = [join(SRC, 'gen')]
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(windowMock.showWarningMessage).toHaveBeenCalledWith(CARVE_FAILED)
    expect(fake.revert).toHaveBeenCalledWith([`${SRC}/...`])
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('skips clean when the directory itself is excluded but still reverts', async () => {
    fake.reconcileExcludeDirs = [SRC]
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(windowMock.showWarningMessage).not.toHaveBeenCalledWith(CARVE_FAILED)
    expect(fake.revert).toHaveBeenCalledWith([`${SRC}/...`])
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })

  it('drops the discard-unopened promise from the confirm when clean is skipped', async () => {
    // The gating runs before the dialog on purpose: promising to discard
    // uncollected work and then keeping it is the one thing a destructive
    // confirm must never do.
    fake.reconcileExcludeDirs = [SRC]
    fake.openedInTree.mockResolvedValueOnce({
      files: [{ path: `${SRC}/opened.ts`, changelist: '5' }],
      unknown: false,
    })
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    const message = windowMock.showWarningMessage.mock.calls[0]?.[0] ?? ''
    expect(message).not.toContain(
      localize(
        'perforce.revert.alsoDirUnopened',
        'Unopened working-tree changes under this directory will also be discarded.',
      ),
    )
  })

  it('counts only the surviving unopened files in the confirm', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    expectConfirmRevert()
    await runCommand('perforce.revert', { resourceUri: `${ROOT}/a.txt` }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: join(ROOT, 'gen', 'b.txt') },
    ])
    const message = windowMock.showWarningMessage.mock.calls[0]?.[0] ?? ''
    expect(message).toContain(
      localize(
        'perforce.revert.discardOne',
        "Discard working-tree changes for '{0}'? This cannot be undone.",
        { 0: 'a.txt' },
      ),
    )
    expect(fake.revertReconcile).toHaveBeenCalledWith([`${ROOT}/a.txt`])
  })

  it('never confirms when exclusions leave nothing to revert or clean', async () => {
    fake.reconcileExcludeDirs = [SRC]
    fake.openedInTree.mockResolvedValueOnce({ files: [], unknown: false })
    await runCommand('perforce.revert', { resourceUri: SRC, isDirectory: true })
    expect(windowMock.showWarningMessage).not.toHaveBeenCalled()
    expect(windowMock.showInformationMessage).toHaveBeenCalledWith(ALL_EXCLUDED)
    expect(fake.revert).not.toHaveBeenCalled()
    expect(fake.revertReconcile).not.toHaveBeenCalled()
  })
})

describe('perforce.reopenTo exclusion gating', () => {
  it('drops excluded uncollected files from reconcileInto', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: join(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.reconcileInto).toHaveBeenCalledWith('5', [`${ROOT}/a.txt`])
    expect(fake.reopen).not.toHaveBeenCalled()
  })

  it('still reopens opened files even under an excluded directory', async () => {
    fake.reconcileExcludeDirs = [join(ROOT, 'gen')]
    fake.changelistOf.mockImplementation((p: string) =>
      p === join(ROOT, 'gen', 'b.txt') ? '7' : undefined,
    )
    await runCommand('perforce.reopenTo', { scmResourceGroupId: 'cl:5' }, [
      { resourceUri: `${ROOT}/a.txt` },
      { resourceUri: join(ROOT, 'gen', 'b.txt') },
    ])
    expect(fake.reconcileInto).toHaveBeenCalledWith('5', [`${ROOT}/a.txt`])
    expect(fake.reopen).toHaveBeenCalledWith('5', [join(ROOT, 'gen', 'b.txt')])
  })
})
