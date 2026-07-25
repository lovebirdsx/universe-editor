import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken, TimelineChangeEvent } from '@universe-editor/extension-api'
import type { Repository } from '../repository.js'
import type { RepositoryManager } from '../repositoryManager.js'
import { createGitTimelineCommands, GitTimelineProvider } from '../timelineProvider.js'

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  getConfig: vi.fn(),
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
}))

vi.mock('../gitService.js', () => ({ gitExec: mocks.gitExec }))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, stat: mocks.stat }))
vi.mock('@universe-editor/extension-api', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: mocks.executeCommand,
  },
  workspace: {
    getConfiguration: () => ({ get: mocks.getConfig }),
  },
}))

const ROOT = process.platform === 'win32' ? 'c:\\repo' : '/repo'
const FILE = join(ROOT, 'src', 'a.ts')
const FILE_URI = pathToFileURL(FILE).href
const REL = 'src/a.ts'
const NO_TOKEN = undefined as unknown as CancellationToken

const FIELD = '\x1f'
function record(hash: string, at: number, subject = `commit ${hash}`): string {
  return [hash, 'Ada', 'ada@x.io', String(at), subject].join(FIELD)
}

function gitOk(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}
function gitFail() {
  return { stdout: '', stderr: 'fatal', exitCode: 128 }
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    root: ROOT,
    getHeadContent: vi.fn(() => Promise.resolve(null)),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
    ...overrides,
  } as unknown as Repository
}

function fakeManager(repo: Repository | undefined): RepositoryManager {
  return { resolveRepo: () => repo } as unknown as RepositoryManager
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getConfig.mockImplementation((_key: string, def: unknown) => Promise.resolve(def))
  mocks.gitExec.mockResolvedValue(gitFail())
  mocks.readFile.mockRejectedValue(new Error('ENOENT'))
  mocks.stat.mockRejectedValue(new Error('ENOENT'))
  mocks.registerCommand.mockImplementation(() => ({ dispose: () => undefined }))
  mocks.executeCommand.mockResolvedValue(undefined)
})

describe('GitTimelineProvider', () => {
  it('builds the git log command with follow, limit+1 probing and the file path', async () => {
    const repo = fakeRepo()
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.gitExec.mockResolvedValue(gitOk(''))

    await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(mocks.gitExec).toHaveBeenCalledWith(
      [
        'log',
        '-z',
        '--follow',
        `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`,
        '--max-count=11',
        '--',
        REL,
      ],
      ROOT,
      undefined,
    )
  })

  it('returns undefined for files outside any repository', async () => {
    const provider = new GitTimelineProvider(fakeManager(undefined))
    await expect(provider.provideTimeline(FILE_URI, {}, NO_TOKEN)).resolves.toBeUndefined()
  })

  it('chains pages: the limit+1 probe becomes the cursor and the page edge previous hash', async () => {
    const repo = fakeRepo()
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.gitExec.mockResolvedValue(
      gitOk([record('c1', 300), record('c2', 200), record('c3', 100)].join('\0')),
    )

    const page = await provider.provideTimeline(FILE_URI, { limit: 2 }, NO_TOKEN)

    expect(page?.cursor).toBe('c3')
    const commits = page?.items.filter((i) => i.contextValue === 'git:file:commit') ?? []
    expect(commits.map((i) => i.id)).toEqual(['c1', 'c2'])
    // c1's previous version is c2; c2's is the probe commit (next page's first row).
    expect(commits[0]?.command?.arguments).toEqual([
      { uri: FILE, currentHash: 'c1', previousHash: 'c2' },
    ])
    expect(commits[1]?.command?.arguments).toEqual([
      { uri: FILE, currentHash: 'c2', previousHash: 'c3' },
    ])

    // Second page starts at the cursor commit and skips the uncommitted entry.
    mocks.gitExec.mockResolvedValue(gitOk([record('c3', 100)].join('\0')))
    const page2 = await provider.provideTimeline(FILE_URI, { limit: 2, cursor: 'c3' }, NO_TOKEN)
    expect(mocks.gitExec).toHaveBeenLastCalledWith(
      expect.arrayContaining(['--max-count=3', 'c3', '--', REL]),
      ROOT,
      undefined,
    )
    expect(page2?.items.every((i) => i.contextValue === 'git:file:commit')).toBe(true)
  })

  it('ends pagination with no cursor; the last commit diffs against its parent', async () => {
    const repo = fakeRepo()
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.gitExec.mockResolvedValue(gitOk([record('c1', 300), record('c2', 200)].join('\0')))

    const page = await provider.provideTimeline(FILE_URI, { limit: 50 }, NO_TOKEN)

    expect(page?.cursor).toBeUndefined()
    const last = page?.items.filter((i) => i.contextValue === 'git:file:commit').at(-1)
    expect(last?.command?.arguments).toEqual([
      { uri: FILE, currentHash: 'c2', previousHash: 'c2^' },
    ])
  })

  it('prepends an Uncommitted Changes entry when the working tree differs from HEAD', async () => {
    const repo = fakeRepo({ getHeadContent: vi.fn(() => Promise.resolve('old')) })
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.readFile.mockResolvedValue('new')
    mocks.stat.mockResolvedValue({ mtimeMs: 1700000000000 })
    mocks.gitExec.mockResolvedValue(gitOk(record('c1', 300)))

    const page = await provider.provideTimeline(FILE_URI, { limit: 50 }, NO_TOKEN)

    const first = page?.items[0]
    expect(first?.label).toBe('Uncommitted Changes')
    expect(first?.contextValue).toBe('git:file:working')
    expect(first?.timestamp).toBe(1700000000000)
    expect(first?.command?.arguments).toEqual([
      { uri: FILE, currentHash: '', previousHash: 'HEAD' },
    ])
  })

  it('omits the uncommitted entry for a clean file or when the setting is off', async () => {
    const repo = fakeRepo({ getHeadContent: vi.fn(() => Promise.resolve('same')) })
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.readFile.mockResolvedValue('same')
    mocks.gitExec.mockResolvedValue(gitOk(record('c1', 300)))

    const clean = await provider.provideTimeline(FILE_URI, { limit: 50 }, NO_TOKEN)
    expect(clean?.items.every((i) => i.contextValue === 'git:file:commit')).toBe(true)

    mocks.getConfig.mockImplementation((key: string, def: unknown) =>
      Promise.resolve(key === 'timeline.showUncommitted' ? false : def),
    )
    const repo2 = fakeRepo({ getHeadContent: vi.fn(() => Promise.resolve('old')) })
    const provider2 = new GitTimelineProvider(fakeManager(repo2))
    mocks.readFile.mockResolvedValue('new')
    const off = await provider2.provideTimeline(FILE_URI, { limit: 50 }, NO_TOKEN)
    expect(off?.items.every((i) => i.contextValue === 'git:file:commit')).toBe(true)
  })

  it('survives git log failures (unborn branch) with just the working-tree entry', async () => {
    const repo = fakeRepo({ getHeadContent: vi.fn(() => Promise.resolve(null)) })
    const provider = new GitTimelineProvider(fakeManager(repo))
    mocks.readFile.mockResolvedValue('brand new file')
    mocks.gitExec.mockResolvedValue(gitFail())

    const page = await provider.provideTimeline(FILE_URI, { limit: 50 }, NO_TOKEN)

    expect(page?.cursor).toBeUndefined()
    expect(page?.items).toHaveLength(1)
    expect(page?.items[0]?.contextValue).toBe('git:file:working')
  })

  it('fires a provider-wide reset when a tracked repo changes', () => {
    let repoListener: (() => void) | undefined
    const repo = fakeRepo({
      onDidChange: vi.fn((l: () => void) => {
        repoListener = l
        return { dispose: () => undefined }
      }),
    })
    const provider = new GitTimelineProvider(fakeManager(repo))
    const seen: TimelineChangeEvent[] = []
    provider.onDidChange?.((e) => seen.push(e))

    provider.trackRepo(repo)
    repoListener?.()

    expect(seen).toEqual([{ reset: true }])
  })
})

describe('git.timeline commands', () => {
  function registeredCommands(): Map<string, (arg?: unknown) => unknown> {
    const map = new Map<string, (arg?: unknown) => unknown>()
    mocks.registerCommand.mockImplementation((id: string, handler: (arg?: unknown) => unknown) => {
      map.set(id, handler)
      return { dispose: () => undefined }
    })
    createGitTimelineCommands(fakeManager(fakeRepo()))
    return map
  }

  it('openDiff reads both blobs and opens the comparison', async () => {
    const commands = registeredCommands()
    mocks.gitExec.mockResolvedValue(gitOk('blob'))

    await commands.get('git.timeline.openDiff')?.({
      uri: FILE,
      currentHash: 'abc1234567890',
      previousHash: 'def0000',
    })

    expect(mocks.gitExec).toHaveBeenCalledWith(['show', `def0000:${REL}`], ROOT, undefined)
    expect(mocks.gitExec).toHaveBeenCalledWith(['show', `abc1234567890:${REL}`], ROOT, undefined)
    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.openDiff', {
      title: 'a.ts (abc1234)',
      originalUri: FILE_URI,
      original: 'blob',
      modified: 'blob',
      pinned: false,
      preserveFocus: false,
      openableUri: FILE_URI,
    })
  })

  it('openDiff with an empty currentHash diffs HEAD against the working tree', async () => {
    const commands = registeredCommands()
    mocks.gitExec.mockResolvedValue(gitOk('head content'))
    mocks.readFile.mockResolvedValue('working content')

    await commands.get('git.timeline.openDiff')?.({
      uri: FILE,
      currentHash: '',
      previousHash: 'HEAD',
    })

    expect(mocks.gitExec).toHaveBeenCalledWith(['show', `HEAD:${REL}`], ROOT, undefined)
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({
        title: 'a.ts (Working Tree)',
        original: 'head content',
        modified: 'working content',
      }),
    )
  })

  it('copy commands route through the renderer clipboard command', async () => {
    const commands = registeredCommands()

    await commands.get('git.timeline.copyCommitId')?.({ id: 'abc123' })
    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.writeClipboard', 'abc123')

    await commands.get('git.timeline.copyCommitMessage')?.({ label: 'fix: thing' })
    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.writeClipboard', 'fix: thing')

    mocks.executeCommand.mockClear()
    await commands.get('git.timeline.copyCommitId')?.({ label: 'no id' })
    expect(mocks.executeCommand).not.toHaveBeenCalled()
  })
})
