import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repository } from '../repository.js'
import type { RepositoryManager } from '../repositoryManager.js'
import { createGitCommandsForTest, normalizeUriArg } from '../extension.js'

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  configValues: new Map<string, unknown>(),
  hasSubmodules: vi.fn(),
}))

vi.mock('../gitService.js', () => ({
  gitExec: mocks.gitExec,
  gitExecBinary: vi.fn(),
  detectRepoRoot: vi.fn(),
}))
// Make the .gitmodules probe a knob instead of touching the filesystem, while
// still routing the update through the real `updateSubmodules` so the git argv
// the extension issues is asserted for real.
vi.mock('../submoduleSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../submoduleSync.js')>()
  return {
    ...actual,
    updateSubmodulesIfPresent: async (root: string, log?: (msg: string) => void) =>
      (await mocks.hasSubmodules(root))
        ? { ran: true, result: await actual.updateSubmodules(root, log) }
        : { ran: false },
  }
})
vi.mock('@universe-editor/extension-api', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: mocks.executeCommand,
  },
  workspace: {
    getConfiguration: () => ({
      get: vi.fn((k: string, d: unknown) =>
        mocks.configValues.has(k) ? mocks.configValues.get(k) : d,
      ),
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
  },
}))

const ROOT = process.platform === 'win32' ? 'c:\\repo' : '/repo'
const FILE = join(ROOT, 'src', 'a.ts')
const FIELD = '\x1f'
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const PARENT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432'

function gitOk(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}
function gitFail() {
  return { stdout: '', stderr: 'fatal', exitCode: 128 }
}

function fakeRepo(root: string): Repository {
  return { root, refresh: vi.fn(async () => {}) } as unknown as Repository
}

function fakeManager(resolve: (arg: unknown) => Repository | undefined): RepositoryManager {
  return {
    resolveRepo: vi.fn(resolve),
    submodulesOf: vi.fn(() => []),
  } as unknown as RepositoryManager
}

function makeCommands(
  resolve: (arg: unknown) => Repository | undefined,
  graph = { current: ROOT },
): Map<string, (...args: unknown[]) => unknown> {
  mocks.registerCommand.mockImplementation(() => ({ dispose: () => undefined }))
  return createGitCommandsForTest(fakeManager(resolve), graph, {
    root: ROOT,
    scanOpts: { maxDepth: 0, ignoredFolders: [] },
    log: () => undefined,
  })
}

function mockCommitDetails() {
  mocks.gitExec.mockImplementation((args: string[]) => {
    if (args[0] === 'show' && args[1] === '-s') {
      return Promise.resolve(
        gitOk([HASH, PARENT, 'Ada', 'ada@x.io', '1700000000', '', '', '', 'fix crash'].join(FIELD)),
      )
    }
    if (args[0] === 'diff') return Promise.resolve(gitOk(['M', 'src/a.ts'].join('\0')))
    return Promise.resolve(gitOk(''))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.configValues.clear()
  mocks.hasSubmodules.mockResolvedValue(false)
  mocks.gitExec.mockResolvedValue(gitFail())
  mocks.executeCommand.mockResolvedValue(undefined)
})

describe('normalizeUriArg', () => {
  it('passes plain fsPaths through', () => {
    expect(normalizeUriArg(FILE)).toBe(FILE)
  })

  it('decodes file URI strings', () => {
    expect(normalizeUriArg(pathToFileURL(FILE).href)).toBe(FILE)
  })

  it('accepts Uri objects via fsPath or file-scheme path', () => {
    expect(normalizeUriArg({ fsPath: FILE })).toBe(FILE)
    const uriPath = pathToFileURL(FILE).pathname
    expect(normalizeUriArg({ scheme: 'file', path: uriPath })).toBe(FILE)
  })

  it('returns undefined for anything unrecognizable', () => {
    expect(normalizeUriArg(undefined)).toBeUndefined()
    expect(normalizeUriArg({ scheme: 'untitled', path: '/x' })).toBeUndefined()
    expect(normalizeUriArg('https://example.com/x')).toBeUndefined()
  })
})

describe('git.viewCommit', () => {
  it('resolves the repo from the uri and opens the commit changes view', async () => {
    const repo = fakeRepo(ROOT)
    const commands = makeCommands(() => repo)
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(pathToFileURL(FILE).href, HASH)

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)
    const [command, payload] = mocks.executeCommand.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(command).toBe('_workbench.showCommitChanges')
    expect(payload.providerId).toBe('git')
    expect(payload.commitRef).toBe(HASH)
    expect(payload.openExternalCommand).toBe('git-graph.openFileDiff')
    expect('contentCommand' in payload).toBe(false)
    expect(payload.metadata).toEqual({
      author: 'Ada',
      authorDate: 1700000000,
      message: 'fix crash',
      parents: [PARENT],
    })
    const files = payload.files as { args: Record<string, unknown> }[]
    expect(files[0]?.args).toMatchObject({ root: ROOT, fromHash: PARENT, toHash: HASH })
  })

  it('accepts an fsPath string and a Uri object alike', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(FILE, HASH)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)

    mocks.executeCommand.mockClear()
    await commands.get('git.viewCommit')?.({ fsPath: FILE }, HASH)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)
  })

  it('falls back to the graph current repo when the uri resolves to nothing', async () => {
    const graph = { current: ROOT }
    const commands = makeCommands(() => undefined, graph)
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(undefined, HASH)

    const payload = mocks.executeCommand.mock.calls[0]?.[1] as {
      files: { args: { root: string } }[]
    }
    expect(payload.files[0]?.args.root).toBe(ROOT)
  })

  it('sets payload.revealPath when the passed file is part of the commit', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(pathToFileURL(FILE).href, HASH)

    const payload = mocks.executeCommand.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.revealPath).toBe('src/a.ts')
  })

  it('sets revealPath from the explicit reveal uri over the repo uri', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(ROOT, HASH, pathToFileURL(FILE).href)

    const payload = mocks.executeCommand.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.revealPath).toBe('src/a.ts')
  })

  it('omits revealPath when the file is not part of the commit', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockCommitDetails()

    await commands.get('git.viewCommit')?.(pathToFileURL(join(ROOT, 'other.ts')).href, HASH)

    const payload = mocks.executeCommand.mock.calls[0]?.[1] as Record<string, unknown>
    expect('revealPath' in payload).toBe(false)
  })

  it('does nothing without a hash or when the commit cannot be read', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))

    await commands.get('git.viewCommit')?.(FILE)
    await commands.get('git.viewCommit')?.(FILE, '')
    expect(mocks.executeCommand).not.toHaveBeenCalled()

    mocks.gitExec.mockResolvedValue(gitFail())
    await commands.get('git.viewCommit')?.(FILE, HASH)
    expect(mocks.executeCommand).not.toHaveBeenCalled()
  })
})

describe('git-graph.openFileDiff', () => {
  const REQ = { fromHash: PARENT, toHash: HASH, path: 'src/a.ts', status: 'M' }

  function mockBlobContents() {
    mocks.gitExec.mockImplementation((args: string[]) => {
      if (args[0] === 'show' && typeof args[1] === 'string' && args[1].includes(':')) {
        return Promise.resolve(gitOk(`content of ${args[1]}`))
      }
      return Promise.resolve(gitFail())
    })
  }

  it('opens the diff focused by default', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockBlobContents()

    await commands.get('git-graph.openFileDiff')?.(REQ)

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({
        original: `content of ${PARENT}:src/a.ts`,
        modified: `content of ${HASH}:src/a.ts`,
        pinned: false,
        preserveFocus: false,
      }),
    )
  })

  it('passes preserveFocus through for Space-preview from the commit-changes view', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockBlobContents()

    await commands.get('git-graph.openFileDiff')?.(REQ, { preserveFocus: true })

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({ preserveFocus: true }),
    )
  })
})

describe('git-graph operation follow-up', () => {
  const OTHER_WT =
    process.platform === 'win32' ? 'c:\\repo.worktrees\\main' : '/repo.worktrees/main'
  const submoduleCalls = (): string[][] =>
    mocks.gitExec.mock.calls
      .map(([args]) => args as string[])
      .filter((args) => args[0] === 'submodule')

  /** Canned responses that route a cherry-pick-to-branch into another worktree. */
  function mockCherryPickIntoOtherWorktree(): void {
    mocks.gitExec.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree') {
        return Promise.resolve(
          gitOk(
            [
              `worktree ${OTHER_WT}`,
              'HEAD aaa',
              'branch refs/heads/main',
              '',
              `worktree ${ROOT}`,
              'HEAD bbb',
              'branch refs/heads/feature',
              '',
            ].join('\n'),
          ),
        )
      }
      return Promise.resolve(gitOk(''))
    })
  }

  it('tells the user when an operation landed in another worktree', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mockCherryPickIntoOtherWorktree()

    await commands.get('git-graph.cherryPickToBranch')?.(HASH, 'main')

    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1)
    expect(String(mocks.showInformationMessage.mock.calls[0]?.[0])).toContain('main')
  })

  it('stays quiet about worktrees when the operation failed', async () => {
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitFail())

    await commands.get('git-graph.cherryPickToBranch')?.(HASH, 'main')

    expect(mocks.showInformationMessage).not.toHaveBeenCalled()
    expect(mocks.showErrorMessage).toHaveBeenCalled()
  })

  it('updates submodules after an operation that moves the working tree', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await commands.get('git-graph.cherrypick')?.(HASH)

    expect(submoduleCalls()).toEqual([['submodule', 'update', '--init', '--recursive']])
  })

  it('skips the submodule update when git.autoUpdateSubmodules is off', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    mocks.configValues.set('autoUpdateSubmodules', false)
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await commands.get('git-graph.cherrypick')?.(HASH)

    expect(submoduleCalls()).toEqual([])
  })

  describe('git-graph.pull', () => {
    const pullCalls = (): string[][] =>
      mocks.gitExec.mock.calls
        .map(([args]) => args as string[])
        .filter((args) => args[0] === 'pull')
    const worktreeCalls = (): string[][] =>
      mocks.gitExec.mock.calls
        .map(([args]) => args as string[])
        .filter((args) => args[0] === 'worktree')
    /** symbolic-ref reports `feature` checked out, so pulls run in place. */
    const mockOnFeature = (): void => {
      mocks.gitExec.mockImplementation((args: string[]) => {
        if (args[0] === 'symbolic-ref') return Promise.resolve(gitOk('feature'))
        return Promise.resolve(gitOk(''))
      })
    }

    it.each([
      ['default', ['pull']],
      ['rebase', ['pull', '--rebase']],
      ['autostash', ['pull', '--rebase', '--autostash']],
    ] as const)('pulls the current branch (%s)', async (mode, argv) => {
      const commands = makeCommands(() => fakeRepo(ROOT))
      mockOnFeature()
      mocks.configValues.set('autoSyncWorktreesAfterPull', false)

      const result = await commands.get('git-graph.pull')?.('feature', mode)

      expect(result).toBe(true)
      expect(pullCalls()).toEqual([argv])
    })

    it('syncs other worktrees to the pulled branch after success', async () => {
      const commands = makeCommands(() => fakeRepo(ROOT))
      mocks.gitExec.mockImplementation((args: string[]) => {
        if (args[0] === 'symbolic-ref') return Promise.resolve(gitOk('feature'))
        if (args[0] === 'rev-parse') return Promise.resolve(gitOk('b'.repeat(40)))
        return Promise.resolve(gitOk(''))
      })

      await commands.get('git-graph.pull')?.('feature', 'default')

      // The sync targets the pulled branch's ref, not HEAD — after a
      // cross-branch pull HEAD is back on the original branch.
      const revParseCalls = mocks.gitExec.mock.calls
        .map(([args]) => args as string[])
        .filter((args) => args[0] === 'rev-parse')
      expect(revParseCalls).toContainEqual(['rev-parse', 'feature'])
      expect(worktreeCalls()).toContainEqual(['worktree', 'list', '--porcelain'])
    })

    it('skips the worktree sync when git.autoSyncWorktreesAfterPull is off', async () => {
      const commands = makeCommands(() => fakeRepo(ROOT))
      mockOnFeature()
      mocks.configValues.set('autoSyncWorktreesAfterPull', false)

      await commands.get('git-graph.pull')?.('feature', 'default')

      expect(worktreeCalls()).toEqual([])
    })

    it('reports the pull failure and skips the worktree sync', async () => {
      const commands = makeCommands(() => fakeRepo(ROOT))
      mocks.gitExec.mockImplementation((args: string[]) => {
        if (args[0] === 'symbolic-ref') return Promise.resolve(gitOk('feature'))
        return Promise.resolve(gitFail())
      })

      const result = await commands.get('git-graph.pull')?.('feature', 'default')

      expect(result).toBe(false)
      expect(mocks.showErrorMessage).toHaveBeenCalled()
      expect(worktreeCalls()).toEqual([])
    })

    it('tells the user when a pull landed in another worktree', async () => {
      const commands = makeCommands(() => fakeRepo(ROOT))
      mocks.configValues.set('autoSyncWorktreesAfterPull', false)
      mocks.gitExec.mockImplementation((args: string[]) => {
        if (args[0] === 'symbolic-ref') return Promise.resolve(gitOk('feature'))
        if (args[0] === 'worktree') {
          return Promise.resolve(
            gitOk(
              [
                `worktree ${OTHER_WT}`,
                'HEAD aaa',
                'branch refs/heads/main',
                '',
                `worktree ${ROOT}`,
                'HEAD bbb',
                'branch refs/heads/feature',
                '',
              ].join('\n'),
            ),
          )
        }
        return Promise.resolve(gitOk(''))
      })

      await commands.get('git-graph.pull')?.('main', 'default')

      expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1)
      expect(String(mocks.showInformationMessage.mock.calls[0]?.[0])).toContain('main')
    })
  })

  it('skips the submodule update when the operation failed', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitFail())

    await commands.get('git-graph.cherrypick')?.(HASH)

    expect(submoduleCalls()).toEqual([])
  })

  it('updates submodules after reset --hard but not after soft or mixed', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await commands.get('git-graph.reset')?.(HASH, 'hard')
    expect(submoduleCalls()).toHaveLength(1)

    vi.clearAllMocks()
    mocks.hasSubmodules.mockResolvedValue(true)
    mocks.gitExec.mockResolvedValue(gitOk(''))
    await commands.get('git-graph.reset')?.(HASH, 'mixed')
    await commands.get('git-graph.reset')?.(HASH, 'soft')
    expect(submoduleCalls()).toEqual([])
  })

  it('does not update submodules for ref-only operations', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    const commands = makeCommands(() => fakeRepo(ROOT))
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await commands.get('git-graph.deleteBranch')?.('stale')
    await commands.get('git-graph.createTag')?.(HASH, 'v1')
    await commands.get('git-graph.stashDrop')?.('stash@{0}')

    expect(submoduleCalls()).toEqual([])
  })

  it('refreshes the submodule repos after updating them', async () => {
    mocks.hasSubmodules.mockResolvedValue(true)
    const sub = fakeRepo(join(ROOT, 'sub'))
    mocks.registerCommand.mockImplementation(() => ({ dispose: () => undefined }))
    const mgr = {
      resolveRepo: vi.fn(() => fakeRepo(ROOT)),
      submodulesOf: vi.fn(() => [sub]),
    } as unknown as RepositoryManager
    const commands = createGitCommandsForTest(
      mgr,
      { current: ROOT },
      {
        root: ROOT,
        scanOpts: { maxDepth: 0, ignoredFolders: [] },
        log: () => undefined,
      },
    )
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await commands.get('git-graph.cherrypick')?.(HASH)

    expect((sub as unknown as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalled()
  })
})
