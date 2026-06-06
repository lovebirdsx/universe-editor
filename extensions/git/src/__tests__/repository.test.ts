import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitPrimaryInputCommand, Repository } from '../repository.js'

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
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
