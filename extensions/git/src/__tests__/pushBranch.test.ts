import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  inspectPushBranch,
  pushBranch,
  type PushBranchExecuteInput,
} from '../delivery/pushBranch.js'

const execFileAsync = promisify(execFile)
const tmpRoots: string[] = []

const git = async (args: readonly string[], cwd?: string): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], {
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

const commitFile = async (
  cwd: string,
  name: string,
  content: string,
  message: string,
): Promise<void> => {
  await writeFile(join(cwd, name), content)
  await git(['add', name], cwd)
  await git(['commit', '-m', message], cwd)
}

const headOf = async (cwd: string): Promise<string> =>
  (await git(['rev-parse', 'HEAD'], cwd)).trim()

interface Fixture {
  readonly root: string
  readonly remote: string
  readonly main: string
  readonly feature: string
}

async function cloneWithIdentity(remote: string, path: string): Promise<void> {
  await git(['clone', remote, path])
  await git(['config', 'user.name', 'Universe Test'], path)
  await git(['config', 'user.email', 'test@example.com'], path)
  await git(['config', 'commit.gpgsign', 'false'], path)
}

async function createFixture(): Promise<Fixture> {
  const root = mkTempDir('ue-git-push-')
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const main = join(root, 'main')
  const feature = join(root, 'feature')

  await git(['init', '--bare', '--initial-branch=main', remote])
  await cloneWithIdentity(remote, main)
  await commitFile(main, 'base.txt', 'base\n', 'initial')
  await git(['push', '-u', 'origin', 'main'], main)
  await git(['worktree', 'add', '-b', 'feature', feature], main)
  await commitFile(feature, 'feature.txt', 'feature\n', 'add feature')

  return { root, remote, main, feature }
}

const executeInput = (
  fixture: Fixture,
  overrides: Partial<PushBranchExecuteInput> = {},
): PushBranchExecuteInput => ({
  sourceCwd: fixture.feature,
  expectedBranch: 'feature',
  expectedHead: '',
  remote: 'origin',
  remoteBranch: 'feature',
  ...overrides,
})

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()
    if (root !== undefined) removeDirWithRetry(root)
  }
})

describe('push branch inspect', () => {
  it('offers to publish a branch that is not on the remote yet', async () => {
    const fixture = await createFixture()

    const result = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blockers).toEqual([])
    expect(result.source.branch).toBe('feature')
    expect(result.source.head).toBe(await headOf(fixture.feature))
    expect(result.source.isMainWorktree).toBe(false)
    expect(result.remote).toMatchObject({
      name: 'origin',
      branch: 'feature',
      exists: false,
      ahead: 0,
      behind: 0,
    })
  })

  it('blocks when the remote branch has commits the worktree does not have', async () => {
    const fixture = await createFixture()
    const first = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const published = await pushBranch(
      executeInput(fixture, { expectedHead: first.source.head }),
      undefined,
    )
    expect(published.ok).toBe(true)

    const other = join(fixture.root, 'other')
    await cloneWithIdentity(fixture.remote, other)
    await git(['checkout', 'feature'], other)
    await commitFile(other, 'remote.txt', 'remote\n', 'remote commit')
    await git(['push', 'origin', 'feature'], other)
    await commitFile(fixture.feature, 'local.txt', 'local\n', 'local commit')

    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.remote).toMatchObject({ exists: true, ahead: 1, behind: 1 })
    expect(inspected.blockers.map((blocker) => blocker.code)).toContain('remote_diverged')
  })

  it('blocks when everything is already pushed', async () => {
    const fixture = await createFixture()
    const first = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const published = await pushBranch(executeInput(fixture, { expectedHead: first.source.head }))
    expect(published.ok).toBe(true)

    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.blockers.map((blocker) => blocker.code)).toContain('nothing_to_push')
  })

  it('warns about uncommitted changes but still offers the push', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')

    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })

    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.source.dirty).toBe(true)
    expect(inspected.blockers).toEqual([])
    expect(inspected.warnings.join('\n')).toContain('Uncommitted changes')
  })

  it('rejects detached HEAD', async () => {
    const fixture = await createFixture()
    await git(['checkout', '--detach'], fixture.feature)

    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })

    expect(inspected.ok).toBe(false)
    if (inspected.ok) return
    expect(inspected.error.code).toBe('detached_source')
  })
})

describe('push branch execute', () => {
  it('publishes the branch and sets its upstream', async () => {
    const fixture = await createFixture()
    const head = await headOf(fixture.feature)
    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return

    const result = await pushBranch(executeInput(fixture, { expectedHead: head }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.published).toBe(true)
    expect(result.remoteBranch).toBe('feature')
    expect((await git(['--git-dir', fixture.remote, 'rev-parse', 'feature'])).trim()).toBe(head)
    expect(
      (await git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'], fixture.feature)).trim(),
    ).toBe('origin/feature')
  })

  it('keeps a custom remote branch name without repointing an existing upstream', async () => {
    const fixture = await createFixture()
    const head = await headOf(fixture.feature)
    await git(['branch', '--set-upstream-to=origin/main', 'feature'], fixture.main)

    const result = await pushBranch(
      executeInput(fixture, { expectedHead: head, remoteBranch: 'tasks/feature' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remoteBranch).toBe('tasks/feature')
    expect(
      (await git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/tasks/feature'])).trim(),
    ).toBe(head)
    expect(
      (await git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'], fixture.feature)).trim(),
    ).toBe('origin/main')
  })

  it('refuses to force-push a diverged branch', async () => {
    const fixture = await createFixture()
    const head = await headOf(fixture.feature)
    await pushBranch(executeInput(fixture, { expectedHead: head }))
    await commitFile(fixture.feature, 'local.txt', 'local\n', 'local commit')

    const other = join(fixture.root, 'other')
    await cloneWithIdentity(fixture.remote, other)
    await git(['checkout', 'feature'], other)
    await commitFile(other, 'remote.txt', 'remote\n', 'remote commit')
    await git(['push', 'origin', 'feature'], other)
    const remoteHead = (await git(['rev-parse', 'feature'], fixture.remote)).trim()

    const inspected = await inspectPushBranch({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return

    const result = await pushBranch({
      ...executeInput(fixture, { expectedHead: await headOf(fixture.feature) }),
      ...(inspected.remote.head !== undefined ? { expectedRemoteHead: inspected.remote.head } : {}),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('remote_diverged')
    expect((await git(['rev-parse', 'feature'], fixture.remote)).trim()).toBe(remoteHead)
  })

  it('stops when the remote moved after the preview', async () => {
    const fixture = await createFixture()
    const head = await headOf(fixture.feature)
    await pushBranch(executeInput(fixture, { expectedHead: head }))
    const staleRemoteHead = (await git(['rev-parse', 'feature'], fixture.remote)).trim()
    await commitFile(fixture.feature, 'second.txt', 'second\n', 'second commit')

    const other = join(fixture.root, 'other')
    await cloneWithIdentity(fixture.remote, other)
    await git(['checkout', 'feature'], other)
    await commitFile(other, 'remote.txt', 'remote\n', 'remote commit')
    await git(['push', 'origin', 'feature'], other)

    const result = await pushBranch(
      executeInput(fixture, {
        expectedHead: await headOf(fixture.feature),
        expectedRemoteHead: staleRemoteHead,
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('remote_moved')
  })

  it('rejects an invalid remote branch name', async () => {
    const fixture = await createFixture()

    const inspected = await inspectPushBranch({
      sourceCwd: fixture.feature,
      remoteBranch: '-oops',
      fetch: false,
    })

    expect(inspected.ok).toBe(false)
    if (inspected.ok) return
    expect(inspected.error.code).toBe('invalid_branch')
  })
})
