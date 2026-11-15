import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { runHeadlessDelivery } from '../delivery/deliveryPipeline.js'
import {
  acquireDeliveryLock,
  deliveryLockDir,
  isDeliveryLockActive,
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
      // A fixed past date keeps the engine's real-time cherry-picks from reproducing
      // a fixture commit's sha when both land in the same second.
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
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
  readonly other: string
  readonly side: string
}

async function cloneWithIdentity(remote: string, path: string): Promise<void> {
  await git(['clone', remote, path])
  await git(['config', 'user.name', 'Universe Test'], path)
  await git(['config', 'user.email', 'test@example.com'], path)
  await git(['config', 'commit.gpgsign', 'false'], path)
}

/** Bare remote, main worktree, a feature worktree and two extra worktrees. */
async function createFixture(): Promise<Fixture> {
  const root = mkTempDir('ue-delivery-pipeline-')
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const main = join(root, 'main')
  const feature = join(root, 'feature')
  const other = join(root, 'other')
  const side = join(root, 'side')

  await git(['init', '--bare', '--initial-branch=main', remote])
  await cloneWithIdentity(remote, main)
  await commitFile(main, 'base.txt', 'base\n', 'initial')
  await git(['push', '-u', 'origin', 'main'], main)
  await git(['worktree', 'add', '-b', 'feature', feature], main)
  await git(['worktree', 'add', '-b', 'other', other], main)
  await git(['worktree', 'add', '-b', 'side', side], main)
  await commitFile(side, 'side.txt', 'side\n', 'side commit')
  await commitFile(feature, 'feature.txt', 'feature\n', 'add feature')

  return { root, remote, main, feature, other, side }
}

async function createConflictFixture(): Promise<Fixture> {
  const root = mkTempDir('ue-delivery-pipeline-conflict-')
  tmpRoots.push(root)
  const remote = join(root, 'remote.git')
  const main = join(root, 'main')
  const feature = join(root, 'feature')
  const other = join(root, 'other')
  const side = join(root, 'side')

  await git(['init', '--bare', '--initial-branch=main', remote])
  await cloneWithIdentity(remote, main)
  await commitFile(main, 'conflict.txt', 'base\n', 'initial')
  await git(['push', '-u', 'origin', 'main'], main)
  await git(['worktree', 'add', '-b', 'feature', feature], main)
  await git(['worktree', 'add', '-b', 'other', other], main)
  await git(['worktree', 'add', '-b', 'side', side], main)
  await commitFile(feature, 'conflict.txt', 'feature\n', 'change on feature')
  await commitFile(main, 'conflict.txt', 'main\n', 'change on main')
  await git(['push', 'origin', 'main'], main)

  return { root, remote, main, feature, other, side }
}

const tempWorktreeRoot = (main: string): string =>
  join(dirname(main), '.universe-editor-delivery-worktrees')

const expectTempWorktreesGone = async (main: string): Promise<void> => {
  const root = tempWorktreeRoot(main)
  if (!existsSync(root)) return
  expect(await readdir(root)).toEqual([])
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()
    if (root !== undefined) removeDirWithRetry(root)
  }
})

describe('headless delivery pipeline', () => {
  it('commits dirty changes, delivers existing commits, pushes and syncs worktrees', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')
    const sourceHeadBefore = await headOf(fixture.feature)

    const outcome = await runHeadlessDelivery({
      sourceCwd: fixture.feature,
      message: 'feat(delivery): 交付测试',
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.delivered.map((commit) => commit.subject)).toEqual([
      'add feature',
      'feat(delivery): 交付测试',
    ])
    expect(outcome.pushedSha).toBeDefined()
    if (outcome.pushedSha === undefined) return

    expect(await headOf(fixture.main)).toBe(outcome.pushedSha)
    expect(await headOf(fixture.feature)).toBe(outcome.pushedSha)
    expect((await git(['rev-parse', 'origin/main'], fixture.main)).trim()).toBe(outcome.pushedSha)
    expect(await headOf(fixture.other)).toBe(outcome.pushedSha)
    expect(await headOf(fixture.side)).not.toBe(outcome.pushedSha)
    expect((await git(['status', '--porcelain'], fixture.feature)).trim()).toBe('')
    expect(await headOf(fixture.feature)).not.toBe(sourceHeadBefore)

    const byBranch = new Map(
      outcome.worktrees
        .filter((result) => result.branch !== undefined)
        .map((result) => [result.branch, result]),
    )
    expect(byBranch.get('main')?.status).toBe('up_to_date')
    expect(byBranch.get('feature')?.status).toBe('synced')
    expect(byBranch.get('other')?.status).toBe('synced')
    expect(byBranch.get('side')?.status).toBe('skipped_diverged')

    const commonDir = outcome.plan?.repository.commonDir
    expect(commonDir).toBeDefined()
    if (commonDir !== undefined) {
      expect(await isDeliveryLockActive(commonDir)).toBeUndefined()
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
    await expectTempWorktreesGone(fixture.main)
  })

  it('returns a plan in dry-run mode without changing anything', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')
    const mainHeadBefore = await headOf(fixture.main)
    const featureHeadBefore = await headOf(fixture.feature)
    const remoteHeadBefore = (await git(['rev-parse', 'origin/main'], fixture.main)).trim()

    const outcome = await runHeadlessDelivery({
      sourceCwd: fixture.feature,
      dryRun: true,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.plan).toBeDefined()
    expect(outcome.plan?.dirty).toBe(true)
    expect(outcome.plan?.commits.map((commit) => commit.subject)).toEqual(['add feature'])
    expect(outcome.plan?.repository.upstreamRef).toBe('origin/main')
    expect(outcome.delivered).toEqual([])
    expect(outcome.pushedSha).toBeUndefined()
    expect(outcome.worktrees).toEqual([])

    expect(await headOf(fixture.main)).toBe(mainHeadBefore)
    expect(await headOf(fixture.feature)).toBe(featureHeadBefore)
    expect((await git(['rev-parse', 'origin/main'], fixture.main)).trim()).toBe(remoteHeadBefore)
    expect((await git(['status', '--porcelain'], fixture.feature)).trim()).toBe('?? wip.txt')

    const commonDir = outcome.plan?.repository.commonDir
    if (commonDir !== undefined) {
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
    await expectTempWorktreesGone(fixture.main)
  })

  it('fails on blockers without touching the repository', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.main, 'dirty.txt'), 'dirty\n')
    const mainHeadBefore = await headOf(fixture.main)
    const featureHeadBefore = await headOf(fixture.feature)

    const outcome = await runHeadlessDelivery({
      sourceCwd: fixture.feature,
      message: 'feat(delivery): 不应执行',
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('main_dirty')
    expect(await headOf(fixture.main)).toBe(mainHeadBefore)
    expect(await headOf(fixture.feature)).toBe(featureHeadBefore)
    const commonDir = outcome.plan?.repository.commonDir
    if (commonDir !== undefined) {
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
    await expectTempWorktreesGone(fixture.main)
  })

  it('aborts conflicts, leaves main untouched and cleans up the temporary worktree', async () => {
    const fixture = await createConflictFixture()
    const mainHeadBefore = await headOf(fixture.main)
    const featureHeadBefore = await headOf(fixture.feature)

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.feature })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('conflict')
    expect(outcome.error?.detail).toContain('conflict.txt')
    expect(outcome.error?.detail).toContain('conflicted commit')
    expect(await headOf(fixture.main)).toBe(mainHeadBefore)
    expect(await headOf(fixture.feature)).toBe(featureHeadBefore)

    const commonDir = outcome.plan?.repository.commonDir
    if (commonDir !== undefined) {
      expect(await isDeliveryLockActive(commonDir)).toBeUndefined()
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
    await expectTempWorktreesGone(fixture.main)
  })

  it('reports lock_held with the current owner', async () => {
    const fixture = await createFixture()
    const commonDir = join(fixture.main, '.git')
    const other = await acquireDeliveryLock({
      commonDir,
      token: 'other-token',
      label: 'other test',
    })
    expect(other.ok && other.acquired).toBe(true)

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.feature })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('lock_held')
    expect(outcome.lockOwner?.token).toBe('other-token')
    expect(outcome.error?.detail).toContain('other test')
    expect(outcome.error?.detail).not.toContain('other-token')
    expect((await isDeliveryLockActive(commonDir))?.token).toBe('other-token')
    await releaseDeliveryLock({ commonDir, token: 'other-token' })
  })

  it('rejects a dirty source tree without a message before acquiring the lock', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.feature, 'wip.txt'), 'wip\n')
    const featureHeadBefore = await headOf(fixture.feature)

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.feature })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('invalid_message')
    expect(await headOf(fixture.feature)).toBe(featureHeadBefore)
    expect((await git(['status', '--porcelain'], fixture.feature)).trim()).toBe('?? wip.txt')
    const commonDir = outcome.plan?.repository.commonDir
    if (commonDir !== undefined) {
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
  })

  it('rejects a formal delivery from the main worktree before blockers fire', async () => {
    const fixture = await createFixture()

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.main })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('unsupported')
    expect(outcome.plan?.source.isMainWorktree).toBe(true)
    expect(outcome.plan?.warnings.some((warning) => warning.includes('main worktree'))).toBe(true)
  })

  it('keeps the plan for a main-worktree dry-run but marks it as undeliverable', async () => {
    const fixture = await createFixture()

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.main, dryRun: true })

    expect(outcome.plan?.source.isMainWorktree).toBe(true)
    expect(outcome.plan?.warnings.some((warning) => warning.includes('main worktree'))).toBe(true)
  })

  it('releases the lock even when an observer throws during cleanup', async () => {
    const fixture = await createConflictFixture()

    const outcome = await runHeadlessDelivery({
      sourceCwd: fixture.feature,
      onPhase: (phase) => {
        if (phase.phase === 'cleanup') throw new Error('observer failed')
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('conflict')
    const commonDir = outcome.plan?.repository.commonDir
    expect(commonDir).toBeDefined()
    if (commonDir !== undefined) {
      expect(await isDeliveryLockActive(commonDir)).toBeUndefined()
      expect(existsSync(deliveryLockDir(commonDir))).toBe(false)
    }
    await expectTempWorktreesGone(fixture.main)
  })

  it('re-checks a landed push before retrying and completes without re-pushing', async () => {
    const fixture = await createFixture()
    const baseline = await headOf(fixture.main)
    const wrapper = join(fixture.root, 'upload-pack-wrapper.mjs')
    const counter = join(fixture.root, 'upload-pack-count')
    // Fail the first four fetches after the remote main moves, so promote's
    // verification gives up while the pipeline's own re-check succeeds.
    await writeFile(
      wrapper,
      [
        "import { execFileSync, spawnSync } from 'node:child_process'",
        "import { readFileSync, writeFileSync } from 'node:fs'",
        'const [gitDir, baselineSha, counterPath, failTimesRaw, ...packArgs] =',
        '  process.argv.slice(2)',
        'const failTimes = Number(failTimesRaw) || 0',
        "const remoteHead = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'refs/heads/main'], {",
        "  encoding: 'utf8',",
        '}).trim()',
        'if (remoteHead !== baselineSha) {',
        '  let count = 0',
        "  try { count = Number(readFileSync(counterPath, 'utf8')) || 0 } catch {}",
        '  if (count < failTimes) {',
        '    writeFileSync(counterPath, String(count + 1))',
        '    process.exit(1)',
        '  }',
        '}',
        "const result = spawnSync('git', ['upload-pack', ...packArgs], { stdio: 'inherit' })",
        'process.exit(result.status ?? 1)',
      ].join('\n'),
    )
    const uploadpack = `node "${wrapper}" "${fixture.remote}" "${baseline}" "${counter}" 4`
    await git(['config', 'remote.origin.uploadpack', uploadpack], fixture.main)

    const outcome = await runHeadlessDelivery({ sourceCwd: fixture.feature })

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.pushedSha).toBeDefined()
    if (outcome.pushedSha === undefined) return
    expect((await git(['rev-parse', 'refs/heads/main'], fixture.remote)).trim()).toBe(
      outcome.pushedSha,
    )
    expect(
      outcome.phases.some((phase) => phase.phase === 'push' && phase.message.includes('复核')),
    ).toBe(true)
    expect(await headOf(fixture.feature)).toBe(outcome.pushedSha)
    await expectTempWorktreesGone(fixture.main)
  })
})
