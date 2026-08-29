import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end cover for post-pull worktree syncing, against a real `git`. The
 * decision logic is unit-tested in worktreeAutoSync.test.ts; what matters here is
 * that a pull through `Repository` actually advances the other worktrees' HEADs
 * (and branch refs) on disk, and leaves the ones carrying work alone.
 */

const configMock = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  reset() {
    configMock.values.clear()
  },
}))

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  RelativePattern: class {
    constructor(
      public readonly base: string,
      public readonly pattern: string,
    ) {}
  },
  scm: {
    createSourceControl: vi.fn(() => ({
      acceptInputCommand: undefined,
      inputBox: { value: '', placeholder: '' },
      count: undefined,
      commitTemplate: undefined,
      createResourceGroup: (id: string, label: string) => ({
        id,
        label,
        hideWhenEmpty: undefined,
        resourceStates: [],
        dispose() {},
      }),
      dispose() {},
    })),
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
        configMock.values.has(key)
          ? configMock.values.get(key)
          : key === 'autofetch'
            ? false
            : fallback,
      ),
    })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose() {} })),
      onDidChange: vi.fn(() => ({ dispose() {} })),
      onDidDelete: vi.fn(() => ({ dispose() {} })),
      dispose() {},
    })),
  },
}))

import { Repository } from '../repository.js'
import { pullBranch } from '../gitGraphActions.js'
import { autoSyncWorktreesAfterPull } from '../worktreeAutoSync.js'

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

const headOf = async (repo: string): Promise<string> =>
  (await git(['rev-parse', 'HEAD'], repo)).trim()

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await writeFile(join(repo, name), content)
  await git(['add', name], repo)
  await git(['commit', '-m', `add ${name}`], repo)
}

/**
 * A clone with one commit pushed, plus a second clone used to publish the commit
 * the local repo will pull. Returns the local clone's path and its HEAD at that
 * point — the commit every worktree below starts from.
 */
async function createRemoteBackedRepo(): Promise<{ local: string; baseHead: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ue-git-wtsync-'))
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const local = join(root, 'local')
  const other = join(root, 'other')

  await git(['init', '--bare', '--initial-branch=main', remote])
  await git(['clone', remote, local])
  await commitFile(local, 'file.txt', 'initial\n')
  await git(['push', '-u', 'origin', 'HEAD:main'], local)

  // Publish a second commit from a separate clone so `local` has something to pull.
  await git(['clone', remote, other])
  await commitFile(other, 'second.txt', 'second\n')
  await git(['push', 'origin', 'HEAD:main'], other)

  return { local, baseHead: await headOf(local) }
}

/** `git worktree add [flags] <path> <commit-ish>` — path precedes the commit. */
const addWorktree = (
  local: string,
  name: string,
  flags: readonly string[],
  commitish: string,
): Promise<string> => git(['worktree', 'add', ...flags, join(local, '..', name), commitish], local)

async function pullWith(local: string): Promise<void> {
  const repo = new Repository(local)
  try {
    await repo.pull()
  } finally {
    repo.dispose()
  }
}

describe('post-pull worktree sync', () => {
  beforeEach(() => configMock.reset())

  afterEach(async () => {
    vi.clearAllMocks()
    for (const root of tmpRoots.splice(0)) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fast-forwards a clean detached worktree to the pulled commit', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'detached')
    await addWorktree(local, 'detached', ['--detach'], baseHead)
    expect(await headOf(wt)).toBe(baseHead)

    await pullWith(local)

    const newHead = await headOf(local)
    expect(newHead).not.toBe(baseHead)
    expect(await headOf(wt)).toBe(newHead)
  })

  it("fast-forwards a branch worktree's branch ref along with it", async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'feature')
    await addWorktree(local, 'feature', ['-b', 'feature'], baseHead)

    await pullWith(local)

    const newHead = await headOf(local)
    expect(await headOf(wt)).toBe(newHead)
    expect((await git(['rev-parse', 'feature'], local)).trim()).toBe(newHead)
  })

  it('leaves a worktree with uncommitted changes untouched', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'dirty')
    await addWorktree(local, 'dirty', ['--detach'], baseHead)
    await writeFile(join(wt, 'file.txt'), 'local edit\n')

    await pullWith(local)

    expect(await headOf(wt)).toBe(baseHead)
    expect((await git(['status', '--porcelain'], wt)).trim()).not.toBe('')
  })

  it('leaves a worktree carrying its own commits untouched', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'diverged')
    await addWorktree(local, 'diverged', ['-b', 'diverged'], baseHead)
    await commitFile(wt, 'own.txt', 'own work\n')
    const divergedHead = await headOf(wt)

    await pullWith(local)

    expect(await headOf(wt)).toBe(divergedHead)
  })

  // A halted operation leaves a clean working tree, so only the marker probe stops
  // the reset from silently discarding it.
  it('leaves a clean worktree halted mid-operation untouched', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'bisecting')
    await addWorktree(local, 'bisecting', ['--detach'], baseHead)
    await git(['bisect', 'start'], wt)
    expect((await git(['status', '--porcelain'], wt)).trim()).toBe('')

    await pullWith(local)

    expect(await headOf(wt)).toBe(baseHead)
  })

  it('syncs nothing when git.autoSyncWorktreesAfterPull is disabled', async () => {
    configMock.values.set('autoSyncWorktreesAfterPull', false)
    const { local, baseHead } = await createRemoteBackedRepo()
    const wt = join(local, '..', 'detached')
    await addWorktree(local, 'detached', ['--detach'], baseHead)

    await pullWith(local)

    expect(await headOf(local)).not.toBe(baseHead)
    expect(await headOf(wt)).toBe(baseHead)
  })

  it('advances several worktrees in one pull', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const detached = join(local, '..', 'wt-detached')
    const branch = join(local, '..', 'wt-branch')
    const dirty = join(local, '..', 'wt-dirty')
    await addWorktree(local, 'wt-detached', ['--detach'], baseHead)
    await addWorktree(local, 'wt-branch', ['-b', 'topic'], baseHead)
    await addWorktree(local, 'wt-dirty', ['--detach'], baseHead)
    await writeFile(join(dirty, 'file.txt'), 'edited\n')

    await pullWith(local)

    const newHead = await headOf(local)
    expect(await headOf(detached)).toBe(newHead)
    expect(await headOf(branch)).toBe(newHead)
    expect(await headOf(dirty)).toBe(baseHead)
  })

  // A Git Graph pull of a branch held elsewhere runs in *that* worktree, so the
  // one the user is sitting in never moves — it has to be fast-forwarded like any
  // other, which the pull-ran-here exclusion used to prevent.
  it('fast-forwards the current worktree when a Graph pull landed in another one', async () => {
    const { local, baseHead } = await createRemoteBackedRepo()
    const task1 = join(local, '..', 'task1')
    await addWorktree(local, 'task1', ['-b', 'task1'], baseHead)

    // `main` is held by `local`, so pulling it from task1 is redirected there.
    const res = await pullBranch(task1, 'main', 'default', undefined)
    expect(res.exitCode).toBe(0)
    expect(res.worktreeName).toBe('local')
    await autoSyncWorktreesAfterPull(task1, 'main', undefined)

    const newHead = await headOf(local)
    expect(newHead).not.toBe(baseHead)
    expect(await headOf(task1)).toBe(newHead)
    expect((await git(['rev-parse', 'task1'], local)).trim()).toBe(newHead)
  })
})
