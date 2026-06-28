import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyWorktreeRemoveFailure,
  gitPrimaryInputCommand,
  parseWorktrees,
  Repository,
} from '../repository.js'

interface FakeCommand {
  readonly command: string
  readonly title: string
  readonly disabled?: boolean
}

interface FakeSourceControl {
  acceptInputCommand: FakeCommand | undefined
  createResourceGroup(
    id: string,
    label: string,
  ): {
    id: string
    label: string
    hideWhenEmpty: boolean | undefined
    resourceStates: unknown[]
    dispose(): void
  }
}

const extensionApiMock = vi.hoisted(() => {
  const sourceControls: FakeSourceControl[] = []
  return {
    sourceControls,
    reset() {
      sourceControls.length = 0
    },
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  scm: {
    createSourceControl: vi.fn(() => {
      const sc = {
        acceptInputCommand: undefined,
        inputBox: { value: '', placeholder: '' },
        count: undefined,
        commitTemplate: undefined,
        createResourceGroup(id: string, label: string) {
          return {
            id,
            label,
            hideWhenEmpty: undefined,
            resourceStates: [],
            dispose() {},
          }
        },
        dispose() {},
      }
      extensionApiMock.sourceControls.push(sc)
      return sc
    }),
  },
  window: {
    createStatusBarItem: vi.fn(() => ({
      text: '',
      tooltip: '',
      command: undefined,
      showProgress: false,
      show() {},
      hide() {},
      dispose() {},
    })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(async (key: string, fallback: unknown) =>
        key === 'autofetch' ? false : fallback,
      ),
    })),
  },
}))

const execFileAsync = promisify(execFile)
const tmpRoots: string[] = []

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Universe Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Universe Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  return stdout
}

async function commitFile(repo: string, content: string, message: string): Promise<void> {
  await writeFile(join(repo, 'file.txt'), content)
  await git(['add', 'file.txt'], repo)
  await git(['commit', '-m', message], repo)
}

async function createRemoteBackedRepo(): Promise<{ root: string; local: string; other: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ue-git-repo-'))
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const local = join(root, 'local')
  const other = join(root, 'other')

  await git(['init', '--bare', remote])
  await git(['clone', remote, local])
  await commitFile(local, 'initial\n', 'initial')
  await git(['push', '-u', 'origin', 'HEAD'], local)
  await git(['clone', remote, other])

  return { root, local, other }
}

async function refreshCommandFor(repoPath: string): Promise<FakeCommand | undefined> {
  const repo = new Repository(repoPath)
  try {
    await repo.refresh({ fetch: true })
    return extensionApiMock.sourceControls.at(-1)?.acceptInputCommand
  } finally {
    repo.dispose()
  }
}

afterEach(async () => {
  extensionApiMock.reset()
  // On Windows a just-finished `git` child can still hold a handle on its repo
  // dir, so rmdir hits EBUSY/EPERM; retry to let the OS release it.
  await Promise.all(
    tmpRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})

describe('gitPrimaryInputCommand', () => {
  it('uses Commit when local changes are present', () => {
    expect(gitPrimaryInputCommand({ hasChanges: true, ahead: 1, behind: 1 })).toEqual({
      command: 'git.commit',
      title: 'Commit',
    })
  })

  it('uses Pull Rebase when local and remote commits both exist', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 1, behind: 1 })).toEqual({
      command: 'git.pullRebase',
      title: 'Pull Rebase',
    })
  })

  it('uses Push when only local commits exist', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 1, behind: 0 })).toEqual({
      command: 'git.push',
      title: 'Push',
    })
  })

  it('uses Pull when only remote commits exist', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 0, behind: 1 })).toEqual({
      command: 'git.pull',
      title: 'Pull',
    })
  })

  it('disables Commit when there is nothing to synchronize', () => {
    expect(gitPrimaryInputCommand({ hasChanges: false, ahead: 0, behind: 0 })).toEqual({
      command: 'git.commit',
      title: 'Commit',
      disabled: true,
    })
  })
})

describe('parseWorktrees', () => {
  it('parses the main worktree, a branch worktree, and a detached one', () => {
    const out = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo.worktrees/feature',
      'HEAD def456',
      'branch refs/heads/feature',
      '',
      'worktree /repo.worktrees/loose',
      'HEAD 789aaa',
      'detached',
      '',
    ].join('\n')

    const result = parseWorktrees(out)
    expect(result).toEqual([
      {
        path: '/repo/main',
        branch: 'main',
        head: 'abc123',
        bare: false,
        detached: false,
        isMain: true,
      },
      {
        path: '/repo.worktrees/feature',
        branch: 'feature',
        head: 'def456',
        bare: false,
        detached: false,
        isMain: false,
      },
      {
        path: '/repo.worktrees/loose',
        branch: undefined,
        head: '789aaa',
        bare: false,
        detached: true,
        isMain: false,
      },
    ])
  })

  it('marks a bare main worktree', () => {
    const out = ['worktree /repo/bare', 'bare', ''].join('\n')
    const [main] = parseWorktrees(out)
    expect(main).toMatchObject({ path: '/repo/bare', bare: true, isMain: true, branch: undefined })
  })

  it('returns an empty list for empty output', () => {
    expect(parseWorktrees('')).toEqual([])
  })
})

describe('classifyWorktreeRemoveFailure', () => {
  it('treats an in-use folder as busy (Windows EINVAL / access denied)', () => {
    expect(
      classifyWorktreeRemoveFailure(
        "error: failed to delete 'D:/git_project/universe-editor2': Invalid argument",
      ),
    ).toBe('busy')
    expect(classifyWorktreeRemoveFailure('Access is denied')).toBe('busy')
    expect(
      classifyWorktreeRemoveFailure(
        'The process cannot access the file because it is being used by another process',
      ),
    ).toBe('busy')
  })

  it('treats POSIX busy/permission errors as busy', () => {
    expect(classifyWorktreeRemoveFailure('rm: cannot remove: Device or resource busy')).toBe('busy')
    expect(classifyWorktreeRemoveFailure('Operation not permitted')).toBe('busy')
  })

  it('treats dirty or locked worktrees as dirty-or-locked', () => {
    expect(
      classifyWorktreeRemoveFailure(
        "fatal: '../wt' contains modified or untracked files, use --force to delete it",
      ),
    ).toBe('dirty-or-locked')
    expect(classifyWorktreeRemoveFailure('fatal: working tree is locked')).toBe('dirty-or-locked')
  })

  it('falls back to other for unrecognized errors', () => {
    expect(classifyWorktreeRemoveFailure('fatal: not a working tree')).toBe('other')
    expect(classifyWorktreeRemoveFailure('')).toBe('other')
  })
})

describe('Repository remote state refresh', () => {
  it('shows Pull after refresh when only the remote has new commits', async () => {
    const { local, other } = await createRemoteBackedRepo()
    await commitFile(other, 'remote\n', 'remote')
    await git(['push'], other)

    await expect(refreshCommandFor(local)).resolves.toEqual({
      command: 'git.pull',
      title: 'Pull',
    })
  })

  it('shows Pull Rebase after refresh when local and remote commits diverged', async () => {
    const { local, other } = await createRemoteBackedRepo()
    await commitFile(other, 'remote\n', 'remote')
    await git(['push'], other)
    await commitFile(local, 'local\n', 'local')

    await expect(refreshCommandFor(local)).resolves.toEqual({
      command: 'git.pullRebase',
      title: 'Pull Rebase',
    })
  })
})
