import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  abortPickDelivery,
  beginDelivery,
  commitSourceDelivery,
  continuePickDelivery,
  hasPendingWork,
  inspectDelivery,
  preparePickDelivery,
  promoteAndPushDelivery,
  restoreMainDelivery,
  syncWorktreesDelivery,
  undeliverDelivery,
} from '../delivery/deliveryGit.js'
import { readDeliveryChangeContext } from '../delivery/deliveryChangeContext.js'
import {
  acquireDeliveryLock,
  heartbeatDeliveryLock,
  releaseDeliveryLock,
} from '../delivery/deliveryLock.js'

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

const headOf = async (cwd: string): Promise<string> =>
  (await git(['rev-parse', 'HEAD'], cwd)).trim()

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
  const root = mkTempDir('ue-git-delivery-')
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

/** Feature and main both edit `conflict.txt`, so the pick always conflicts. */
async function createConflictFixture(): Promise<Fixture> {
  const root = mkTempDir('ue-git-delivery-')
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const main = join(root, 'main')
  const feature = join(root, 'feature')

  await git(['init', '--bare', '--initial-branch=main', remote])
  await cloneWithIdentity(remote, main)
  await commitFile(main, 'conflict.txt', 'base\n', 'initial')
  await git(['push', '-u', 'origin', 'main'], main)
  await git(['worktree', 'add', '-b', 'feature', feature], main)
  await commitFile(feature, 'conflict.txt', 'feature\n', 'change on feature')
  await commitFile(main, 'conflict.txt', 'main\n', 'change on main')
  await git(['push', 'origin', 'main'], main)

  return { root, remote, main, feature }
}

/**
 * A repo carrying a submodule whose configured URL does not exist. The delivery
 * must never initialize submodules in the temp worktree, so the broken URL
 * would fail the pick if the old unconditional `submodule update` came back.
 */
async function createSubmoduleFixture(): Promise<Fixture> {
  const root = mkTempDir('ue-git-delivery-submodule-')
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const main = join(root, 'main')
  const feature = join(root, 'feature')
  const sub = join(root, 'sub')

  await git(['init', '--initial-branch=main', sub])
  await git(['config', 'user.name', 'Universe Test'], sub)
  await git(['config', 'user.email', 'test@example.com'], sub)
  await writeFile(join(sub, 'sub.txt'), 'sub\n')
  await git(['add', 'sub.txt'], sub)
  await git(['commit', '-m', 'sub initial'], sub)

  await git(['init', '--bare', '--initial-branch=main', remote])
  await cloneWithIdentity(remote, main)
  await commitFile(main, 'base.txt', 'base\n', 'initial')
  await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor/sub'], main)
  await git(['commit', '-m', 'add submodule'], main)
  await git(['config', 'submodule.vendor/sub.url', join(root, 'missing-sub')], main)
  await git(['push', '-u', 'origin', 'main'], main)
  await git(['worktree', 'add', '-b', 'feature', feature], main)
  await commitFile(feature, 'feature.txt', 'feature\n', 'add feature')

  return { root, remote, main, feature }
}

const token = 'delivery-token-1'

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()
    if (root !== undefined) removeDirWithRetry(root)
  }
})

describe('delivery inspect', () => {
  it('reports the commits to cherry-pick and the main/upstream heads', async () => {
    const fixture = await createFixture()

    const result = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blockers).toEqual([])
    expect(result.repository.mainBranch).toBe('main')
    expect(result.repository.remote).toBe('origin')
    expect(result.repository.upstreamRef).toBe('origin/main')
    expect(result.repository.canFastForward).toBe(false)
    expect(result.source.branch).toBe('feature')
    expect(result.source.dirty).toBe(false)
    expect(result.commits.map((commit) => commit.subject)).toEqual(['add feature'])
    expect(result.baseSha).toBe(result.repository.mainHead)
  })

  it('blocks when the main worktree is dirty', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.main, 'dirty.txt'), 'dirty\n')

    const result = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blockers.map((blocker) => blocker.code)).toContain('main_dirty')
  })

  it('blocks when main has diverged from its upstream', async () => {
    const fixture = await createFixture()
    const other = join(fixture.root, 'other')
    await cloneWithIdentity(fixture.remote, other)
    await commitFile(other, 'remote.txt', 'remote\n', 'remote commit')
    await git(['push', 'origin', 'main'], other)
    await commitFile(fixture.main, 'local.txt', 'local\n', 'local commit')

    const result = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repository.aheadOfUpstream).toBe(1)
    expect(result.repository.behindUpstream).toBe(1)
    expect(result.blockers.map((blocker) => blocker.code)).toContain('main_diverged')
  })

  it('blocks merge commits in the delivery range', async () => {
    const fixture = await createFixture()
    await git(['branch', 'side'], fixture.feature)
    const side = join(fixture.root, 'side')
    await git(['worktree', 'add', side, 'side'], fixture.feature)
    await commitFile(side, 'side.txt', 'side\n', 'side commit')
    await git(['merge', '--no-ff', 'side', '-m', 'merge side'], fixture.feature)

    const result = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blockers.map((blocker) => blocker.code)).toContain('merge_commit_unsupported')
  })
})

describe('delivery pending work', () => {
  it('reports a clean worktree with no commits ahead of main as pending-free', async () => {
    const fixture = await createFixture()
    await git(['reset', '--hard', 'main'], fixture.feature)

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: false, dirty: false, commitCount: 0 })
  })

  it('reports commits outside main', async () => {
    const fixture = await createFixture()

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: true, dirty: false, commitCount: 1 })
  })

  it('reports uncommitted changes without consulting main', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')
    await git(['checkout', '--detach'], fixture.main)

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: true, dirty: true, commitCount: 0 })
  })

  it('counts untracked files as pending', async () => {
    const fixture = await createFixture()
    await git(['reset', '--hard', 'main'], fixture.feature)
    await writeFile(join(fixture.feature, 'untracked.txt'), 'untracked\n')

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: true, dirty: true, commitCount: 0 })
  })

  it('ignores commits that already reached main', async () => {
    const fixture = await createFixture()
    await git(['merge', '--ff-only', 'feature'], fixture.main)

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: false, dirty: false, commitCount: 0 })
  })

  it('does not count commits already on the upstream when main is behind', async () => {
    const fixture = await createFixture()
    await git(['push', 'origin', 'feature:main'], fixture.feature)

    const upToDate = await hasPendingWork({ sourceCwd: fixture.feature })
    expect(upToDate).toMatchObject({ ok: true, pending: false, dirty: false, commitCount: 0 })

    await commitFile(fixture.feature, 'more.txt', 'more\n', 'more feature')
    const next = await hasPendingWork({ sourceCwd: fixture.feature })
    expect(next).toMatchObject({ ok: true, pending: true, dirty: false, commitCount: 1 })
  })

  it('falls back to main when the main branch has no upstream', async () => {
    const fixture = await createFixture()
    await git(['branch', '--unset-upstream', 'main'], fixture.main)

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result).toMatchObject({ ok: true, pending: true, dirty: false, commitCount: 1 })
  })

  it('resolves a session cwd nested inside the worktree', async () => {
    const fixture = await createFixture()
    const nested = join(fixture.feature, 'src')
    await mkdir(nested, { recursive: true })

    const result = await hasPendingWork({ sourceCwd: nested })

    expect(result).toMatchObject({ ok: true, pending: true, dirty: false, commitCount: 1 })
  })

  it('reports pending only for uncommitted changes in the main worktree', async () => {
    const fixture = await createFixture()

    const clean = await hasPendingWork({ sourceCwd: fixture.main })
    expect(clean).toMatchObject({ ok: true, pending: false, dirty: false, commitCount: 0 })

    await writeFile(join(fixture.main, 'wip.txt'), 'wip\n')
    const dirty = await hasPendingWork({ sourceCwd: fixture.main })
    expect(dirty).toMatchObject({ ok: true, pending: true, dirty: true, commitCount: 0 })
  })

  it('fails outside a repository', async () => {
    const dir = mkTempDir('ue-git-pending-')
    tmpRoots.push(dir)

    const result = await hasPendingWork({ sourceCwd: dir })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not_a_repository')
  })

  it('fails when a clean source worktree has a detached main', async () => {
    const fixture = await createFixture()
    await git(['reset', '--hard', 'main'], fixture.feature)
    await git(['checkout', '--detach'], fixture.main)

    const result = await hasPendingWork({ sourceCwd: fixture.feature })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('detached_main')
  })
})

describe('delivery pipeline', () => {
  it('generates a commit for a dirty source tree and advances its HEAD', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.source.dirty).toBe(true)

    const lock = await acquireDeliveryLock({
      commonDir: inspected.repository.commonDir,
      token,
      label: 'test',
    })
    expect(lock.ok && lock.acquired).toBe(true)

    const began = await beginDelivery({
      commonDir: inspected.repository.commonDir,
      deliveryId: 'dirty-delivery',
      token,
      mainWorktree: inspected.repository.mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch: inspected.repository.targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote: inspected.repository.remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)

    const context = await readDeliveryChangeContext({ sourceWorktree: fixture.feature })
    expect(context.ok).toBe(true)
    if (context.ok) expect(context.fingerprint).toHaveLength(40)

    const committed = await commitSourceDelivery({
      commonDir: inspected.repository.commonDir,
      deliveryId: 'dirty-delivery',
      token,
      sourceWorktree: fixture.feature,
      expectedSourceHead: inspected.source.head,
      message: 'add wip file',
    })
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    expect(committed.head).not.toBe(inspected.source.head)
    expect((await git(['log', '-1', '--format=%s'], fixture.feature)).trim()).toBe('add wip file')
    await releaseDeliveryLock({ commonDir: inspected.repository.commonDir, token })
  })

  it('cherry-picks into a temp worktree, pushes, syncs safe worktrees and undoes', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree, targetBranch, remote } = inspected.repository
    const lock = await acquireDeliveryLock({ commonDir, token })
    expect(lock.ok && lock.acquired).toBe(true)

    const dirtyPath = join(fixture.root, 'dirty-wt')
    const divergedPath = join(fixture.root, 'diverged-wt')
    await git(['worktree', 'add', '-b', 'dirty-wt', dirtyPath, inspected.baseSha], fixture.main)
    await writeFile(join(dirtyPath, 'pending.txt'), 'pending\n')
    await git(
      ['worktree', 'add', '-b', 'diverged-wt', divergedPath, inspected.baseSha],
      fixture.main,
    )
    await commitFile(divergedPath, 'own.txt', 'own\n', 'own commit')

    const began = await beginDelivery({
      commonDir,
      deliveryId: 'full-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)
    if (!began.ok) return

    // A cherry-pick reuses the parent and tree; if the committer timestamp is
    // the same second, the picked commit hashes identically and the source is
    // legitimately `up_to_date` instead of being reset. Cross the second
    // boundary so this test exercises the reset path.
    await new Promise((resolve) => setTimeout(resolve, 1100))

    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'full-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    expect(picked.status).toBe('picked')
    expect(picked.picked).toHaveLength(1)
    expect(picked.picked[0]?.subject).toBe('add feature')

    const promoted = await promoteAndPushDelivery({
      commonDir,
      deliveryId: 'full-delivery',
      token,
      mainWorktree,
      targetBranch,
      baseSha: inspected.baseSha,
      tempWorktree: picked.tempWorktree,
      tempHead: picked.tempHead,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(promoted.ok).toBe(true)
    if (!promoted.ok) return
    expect(await headOf(fixture.main)).toBe(promoted.pushedSha)

    const synced = await syncWorktreesDelivery({
      commonDir,
      deliveryId: 'full-delivery',
      token,
      mainWorktree,
      newHead: promoted.pushedSha,
      sourceWorktree: fixture.feature,
      expectedSourceHead: inspected.source.head,
      tempWorktree: picked.tempWorktree,
    })
    expect(synced.ok).toBe(true)
    if (!synced.ok) return
    const byName = new Map(synced.results.map((entry) => [entry.name, entry.status]))
    expect(byName.get('feature')).toBe('synced')
    expect(byName.get('main')).toBe('up_to_date')
    expect(byName.get('dirty-wt')).toBe('skipped_dirty')
    expect(byName.get('diverged-wt')).toBe('skipped_diverged')
    expect(await headOf(fixture.feature)).toBe(promoted.pushedSha)

    const undone = await undeliverDelivery({
      commonDir,
      deliveryId: 'full-delivery',
      token,
      mainWorktree,
      targetBranch,
      pushedSha: promoted.pushedSha,
      deliveredShas: picked.picked.map((commit) => commit.sha),
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    const log = await git(['log', '--format=%s', '-3'], fixture.main)
    expect(log).toContain('Revert')
    expect(log).toContain('add feature')
    await releaseDeliveryLock({ commonDir, token })
  })

  it('reports a landed push as unverified when the verification fetch keeps failing', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree, targetBranch, remote } = inspected.repository
    const lock = await acquireDeliveryLock({ commonDir, token })
    expect(lock.ok && lock.acquired).toBe(true)

    const began = await beginDelivery({
      commonDir,
      deliveryId: 'flaky-network-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)
    if (!began.ok) return

    await new Promise((resolve) => setTimeout(resolve, 1100))

    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'flaky-network-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return

    // Break fetch only (upload-pack); push uses receive-pack and still lands.
    await git(
      ['config', 'remote.origin.uploadpack', join(fixture.root, 'missing-upload-pack')],
      mainWorktree,
    )

    const promoted = await promoteAndPushDelivery({
      commonDir,
      deliveryId: 'flaky-network-delivery',
      token,
      mainWorktree,
      targetBranch,
      baseSha: inspected.baseSha,
      tempWorktree: picked.tempWorktree,
      tempHead: picked.tempHead,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })

    expect(promoted.ok).toBe(false)
    if (promoted.ok) return
    expect(promoted.error.code).toBe('push_unverified')
    expect((await git(['rev-parse', 'refs/heads/main'], fixture.remote)).trim()).toBe(
      picked.tempHead,
    )
    await releaseDeliveryLock({ commonDir, token })
  })

  it('refuses to begin when the main worktree switched branches', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree, targetBranch, remote } = inspected.repository
    const lock = await acquireDeliveryLock({ commonDir, token })
    expect(lock.ok && lock.acquired).toBe(true)

    await git(['switch', '-c', 'wip'], fixture.main)
    const began = await beginDelivery({
      commonDir,
      deliveryId: 'branch-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(false)
    if (!began.ok) expect(began.error.code).toBe('target_branch_mismatch')
    expect(await headOf(fixture.main)).toBe(inspected.baseSha)
    await releaseDeliveryLock({ commonDir, token })
  })

  it('refuses to promote after the main worktree switched branches', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree, targetBranch, remote } = inspected.repository
    const lock = await acquireDeliveryLock({ commonDir, token })
    expect(lock.ok && lock.acquired).toBe(true)

    const began = await beginDelivery({
      commonDir,
      deliveryId: 'promote-branch-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)
    if (!began.ok) return
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'promote-branch-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return

    await git(['switch', '-c', 'wip'], fixture.main)
    const promoted = await promoteAndPushDelivery({
      commonDir,
      deliveryId: 'promote-branch-delivery',
      token,
      mainWorktree,
      targetBranch,
      baseSha: inspected.baseSha,
      tempWorktree: picked.tempWorktree,
      tempHead: picked.tempHead,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(promoted.ok).toBe(false)
    if (!promoted.ok) expect(promoted.error.code).toBe('target_branch_mismatch')
    // Neither the switched branch nor the remote main may move.
    expect(await headOf(fixture.main)).toBe(inspected.baseSha)
    expect((await git(['rev-parse', 'main'], fixture.remote)).trim()).toBe(
      inspected.repository.upstreamHead,
    )
    await releaseDeliveryLock({ commonDir, token })
  })

  it('pushes again when main was already moved before a restart', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree, targetBranch, remote } = inspected.repository
    const lock = await acquireDeliveryLock({ commonDir, token })
    expect(lock.ok && lock.acquired).toBe(true)

    const began = await beginDelivery({
      commonDir,
      deliveryId: 'resume-push-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)
    if (!began.ok) return
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'resume-push-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return

    // Crash after `reset --hard tempHead` but before the push: main is already
    // on the picked commit while the remote still points at the base.
    await git(['reset', '--hard', picked.tempHead], fixture.main)
    const promoted = await promoteAndPushDelivery({
      commonDir,
      deliveryId: 'resume-push-delivery',
      token,
      mainWorktree,
      targetBranch,
      baseSha: inspected.baseSha,
      tempWorktree: picked.tempWorktree,
      tempHead: picked.tempHead,
      remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(promoted.ok).toBe(true)
    expect((await git(['rev-parse', 'main'], fixture.remote)).trim()).toBe(picked.tempHead)
    await releaseDeliveryLock({ commonDir, token })
  })

  it('restores main without touching the source when a delivery is abandoned', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const began = await beginDelivery({
      commonDir,
      deliveryId: 'restore-delivery',
      token,
      mainWorktree,
      sourceCwd: fixture.feature,
      targetBranch: inspected.repository.targetBranch,
      expectedMainHead: inspected.repository.mainHead,
      expectedUpstreamHead: inspected.repository.upstreamHead,
      expectedSourceHead: inspected.source.head,
      remote: inspected.repository.remote,
      upstreamRef: inspected.repository.upstreamRef,
    })
    expect(began.ok).toBe(true)
    const restored = await restoreMainDelivery({
      mainWorktree,
      expectedCurrentHead: inspected.repository.mainHead,
      restoreToHead: inspected.repository.mainHead,
    })
    expect(restored.ok).toBe(true)
    expect(await headOf(fixture.feature)).toBe(inspected.source.head)
    await releaseDeliveryLock({ commonDir, token })
  })

  it('keeps the temp worktree on conflict and removes it on abort', async () => {
    const fixture = await createConflictFixture()

    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'conflict-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    expect(picked.status).toBe('conflict')
    expect(picked.conflictFiles).toContain('conflict.txt')
    expect(picked.remainingCommits).toHaveLength(1)

    const aborted = await abortPickDelivery({
      commonDir,
      deliveryId: 'conflict-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
    })
    expect(aborted.ok && aborted.removed).toBe(true)
    const worktrees = await git(['worktree', 'list', '--porcelain'], fixture.main)
    expect(worktrees).not.toContain('.universe-editor-delivery-worktrees')
    await releaseDeliveryLock({ commonDir, token })
  })

  it('removes the temp worktree when the pick fails', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })

    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'failed-pick-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    })

    expect(picked.ok).toBe(false)
    if (!picked.ok) expect(picked.error.code).toBe('git_failed')
    const worktrees = await git(['worktree', 'list', '--porcelain'], fixture.main)
    expect(worktrees).not.toContain('.universe-editor-delivery-worktrees')
    await releaseDeliveryLock({ commonDir, token })
  })

  it('derives the temp worktree path when abort omits it', async () => {
    const fixture = await createConflictFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'derived-abort-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    expect(picked.status).toBe('conflict')

    // The renderer cannot know the path when prepare dies mid-command, so it
    // aborts by delivery id alone.
    const aborted = await abortPickDelivery({
      commonDir,
      deliveryId: 'derived-abort-delivery',
      token,
      mainWorktree,
    })
    expect(aborted.ok && aborted.removed).toBe(true)
    const worktrees = await git(['worktree', 'list', '--porcelain'], fixture.main)
    expect(worktrees).not.toContain('.universe-editor-delivery-worktrees')
    await releaseDeliveryLock({ commonDir, token })
  })

  it('picks without initializing submodules in the temp worktree', async () => {
    const fixture = await createSubmoduleFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })

    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'submodule-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })

    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    expect(picked.status).toBe('picked')
    // `-` means the submodule was never initialized in the temp worktree.
    expect((await git(['submodule', 'status'], picked.tempWorktree)).startsWith('-')).toBe(true)
    await abortPickDelivery({
      commonDir,
      deliveryId: 'submodule-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
    })
    await releaseDeliveryLock({ commonDir, token })
  })

  it('continues the pick after the resolver edits the conflicted file', async () => {
    const fixture = await createConflictFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'resolved-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok || picked.status !== 'conflict') return

    await writeFile(join(picked.tempWorktree, 'conflict.txt'), 'resolved\n')
    const continued = await continuePickDelivery({
      commonDir,
      deliveryId: 'resolved-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
      remainingCommits: picked.remainingCommits,
      conflictFiles: picked.conflictFiles,
      expectedTempHead: picked.tempHead,
    })
    expect(continued.ok).toBe(true)
    if (!continued.ok) return
    expect(continued.status).toBe('picked')
    expect(continued.picked.map((commit) => commit.subject)).toEqual(['change on feature'])
    await abortPickDelivery({
      commonDir,
      deliveryId: 'resolved-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
    })
    await releaseDeliveryLock({ commonDir, token })
  })

  it('rejects a resolver that edits files outside the conflict set', async () => {
    const fixture = await createConflictFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'outside-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok || picked.status !== 'conflict') return

    await writeFile(join(picked.tempWorktree, 'conflict.txt'), 'resolved\n')
    await writeFile(join(picked.tempWorktree, 'outside.txt'), 'not allowed\n')
    const continued = await continuePickDelivery({
      commonDir,
      deliveryId: 'outside-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
      remainingCommits: picked.remainingCommits,
      conflictFiles: picked.conflictFiles,
    })
    expect(continued.ok).toBe(false)
    if (!continued.ok) expect(continued.error.code).toBe('source_changed')
    await abortPickDelivery({
      commonDir,
      deliveryId: 'outside-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
    })
    await releaseDeliveryLock({ commonDir, token })
  })

  it('rejects conflict markers left by the resolver', async () => {
    const fixture = await createConflictFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'marker-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok || picked.status !== 'conflict') return

    await writeFile(
      join(picked.tempWorktree, 'conflict.txt'),
      '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\n',
    )
    const continued = await continuePickDelivery({
      commonDir,
      deliveryId: 'marker-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
      remainingCommits: picked.remainingCommits,
      conflictFiles: picked.conflictFiles,
    })
    expect(continued.ok).toBe(false)
    if (!continued.ok) expect(continued.error.code).toBe('conflict')
    await abortPickDelivery({
      commonDir,
      deliveryId: 'marker-delivery',
      token,
      mainWorktree,
      tempWorktree: picked.tempWorktree,
    })
    await releaseDeliveryLock({ commonDir, token })
  })

  it('skips empty commits instead of failing the pick', async () => {
    const fixture = await createFixture()
    await git(['commit', '--allow-empty', '-m', 'empty commit'], fixture.feature)
    await commitFile(fixture.feature, 'later.txt', 'later\n', 'later commit')
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: true })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.commits).toHaveLength(3)

    const { commonDir, mainWorktree } = inspected.repository
    await acquireDeliveryLock({ commonDir, token })
    const picked = await preparePickDelivery({
      commonDir,
      deliveryId: 'empty-delivery',
      token,
      mainWorktree,
      sourceWorktree: fixture.feature,
      baseSha: inspected.baseSha,
      sourceHead: inspected.source.head,
      commits: inspected.commits.map((commit) => commit.sha),
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    expect(picked.status).toBe('picked')
    expect(picked.skippedEmpty).toHaveLength(1)
    expect(picked.picked.map((commit) => commit.subject)).toEqual(['add feature', 'later commit'])
    await releaseDeliveryLock({ commonDir, token })
  })
})

describe('delivery lock', () => {
  it('rejects a second owner, heartbeats and releases by token', async () => {
    const fixture = await createFixture()
    const inspected = await inspectDelivery({ sourceCwd: fixture.feature, fetch: false })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    const commonDir = inspected.repository.commonDir

    const first = await acquireDeliveryLock({ commonDir, token: 'token-a' })
    expect(first.ok && first.acquired).toBe(true)
    const second = await acquireDeliveryLock({ commonDir, token: 'token-b' })
    expect(second.ok && second.acquired).toBe(false)
    if (second.ok && !second.acquired) expect(second.owner?.token).toBe('token-a')

    const heartbeat = await heartbeatDeliveryLock({ commonDir, token: 'token-a' })
    expect(heartbeat.ok).toBe(true)
    const wrongRelease = await releaseDeliveryLock({ commonDir, token: 'token-b' })
    expect(wrongRelease.ok).toBe(false)
    const release = await releaseDeliveryLock({ commonDir, token: 'token-a' })
    expect(release.ok && release.released).toBe(true)
    const reacquired = await acquireDeliveryLock({ commonDir, token: 'token-b' })
    expect(reacquired.ok && reacquired.acquired).toBe(true)
    await releaseDeliveryLock({ commonDir, token: 'token-b' })
  })
})
