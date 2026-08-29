import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { pullBranch } from '../gitGraphActions.js'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): GitExecResult => ({ stdout: '', stderr, exitCode: 1 })

interface Call {
  args: readonly string[]
  cwd: string
}

const ROOT = '/repo'
const BRANCH = 'feature'

/** The main working tree (holds `main`) while the graph's tree lives at CUR. */
const HOLDER = '/repo'
const CUR = '/repo.wt'

const PORCELAIN = [
  `worktree ${HOLDER}`,
  'HEAD aaa',
  'branch refs/heads/main',
  '',
  `worktree ${CUR}`,
  'HEAD bbb',
  'branch refs/heads/feature',
  '',
].join('\n')

interface SetupOpts {
  /** symbolic-ref 输出；默认 'main'。null = 空 stdout（detached HEAD）。 */
  headBranch?: string | null
  /** rev-parse HEAD 输出（detached 兜底），默认 'abc1234' */
  detachedSha?: string
  /** status --porcelain 输出，默认 ''（干净） */
  status?: string
  /** `worktree list --porcelain` 输出，默认 ''（无 worktree 信息） */
  worktreePorcelain?: string
  worktreeListFail?: boolean
  /** holder 树路径（status 按 cwd 区分用），默认 '/repo' */
  holderPath?: string
  /** holder 树的 status 输出，默认 ''（干净） */
  holderStatus?: string
  holderStatusFail?: boolean
  checkoutFail?: 'target' | 'restore'
  pullFail?: boolean
  stashPushFail?: boolean
  popFail?: boolean
}

function setup(opts: SetupOpts = {}): Call[] {
  const calls: Call[] = []
  const headBranch = opts.headBranch === undefined ? 'main' : opts.headBranch
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'symbolic-ref') return Promise.resolve(ok(headBranch ?? ''))
    if (args[0] === 'worktree') {
      return Promise.resolve(
        opts.worktreeListFail
          ? fail('fatal: not a git repository')
          : ok(opts.worktreePorcelain ?? ''),
      )
    }
    if (args[0] === 'rev-parse') return Promise.resolve(ok(opts.detachedSha ?? 'abc1234'))
    if (args[0] === 'status') {
      if (cwd === opts.holderPath) {
        return Promise.resolve(
          opts.holderStatusFail
            ? fail('fatal: unable to read worktree')
            : ok(opts.holderStatus ?? ''),
        )
      }
      return Promise.resolve(ok(opts.status ?? ''))
    }
    if (args[0] === 'stash' && args[1] === 'push') {
      return Promise.resolve(opts.stashPushFail ? fail('fatal: stash push failed') : ok())
    }
    if (args[0] === 'checkout') {
      if (opts.checkoutFail === 'target' && args[1] === BRANCH) {
        return Promise.resolve(fail(`fatal: '${BRANCH}' is already used by worktree`))
      }
      if (opts.checkoutFail === 'restore' && args[1] !== BRANCH) {
        return Promise.resolve(fail('error: Your local changes would be overwritten by checkout'))
      }
      return Promise.resolve(ok())
    }
    if (args[0] === 'pull') {
      return Promise.resolve(opts.pullFail ? fail("fatal: couldn't find remote ref") : ok())
    }
    if (args[0] === 'stash' && args[1] === 'pop') {
      return Promise.resolve(
        opts.popFail ? fail('CONFLICT (content): Merge conflict in a.txt') : ok(),
      )
    }
    return Promise.resolve(ok())
  })
  return calls
}

describe('pullBranch', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['default', ['pull']],
    ['rebase', ['pull', '--rebase']],
    ['autostash', ['pull', '--rebase', '--autostash']],
  ] as const)('pulls in place on the current branch (%s)', async (mode, argv) => {
    const calls = setup({ headBranch: BRANCH })

    const res = await pullBranch(ROOT, BRANCH, mode, undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toEqual([
      { args: ['symbolic-ref', '--short', '-q', 'HEAD'], cwd: ROOT },
      { args: argv, cwd: ROOT },
    ])
  })

  it('falls back to a plain pull for an unknown mode', async () => {
    const calls = setup({ headBranch: BRANCH })

    const res = await pullBranch(ROOT, BRANCH, 'bogus' as never, undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['pull'], cwd: ROOT })
  })

  it('stashes, checks out, pulls, restores, and pops on another branch', async () => {
    const calls = setup({ status: ' M a.txt\n' })

    const res = await pullBranch(ROOT, BRANCH, 'rebase', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls.map((c) => c.args)).toEqual([
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      ['worktree', 'list', '--porcelain'],
      ['status', '--porcelain'],
      ['stash', 'push', '--include-untracked'],
      ['checkout', BRANCH],
      ['pull', '--rebase'],
      ['checkout', 'main'],
      ['stash', 'pop'],
    ])
  })

  it('skips the stash when the tree is clean', async () => {
    const calls = setup({})

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls.some((c) => c.args[0] === 'stash')).toBe(false)
  })

  it('restores HEAD and stash when the pull fails', async () => {
    const calls = setup({ status: ' M a.txt\n', pullFail: true })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("couldn't find remote ref")
    expect(calls).toContainEqual({ args: ['checkout', 'main'], cwd: ROOT })
    expect(calls).toContainEqual({ args: ['stash', 'pop'], cwd: ROOT })
  })

  it('stays on the target branch when the restore checkout fails', async () => {
    const calls = setup({ status: ' M a.txt\n', pullFail: true, checkoutFail: 'restore' })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('would be overwritten by checkout')
    expect(calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'pop')).toBe(false)
  })

  it('restores the stash when the target checkout fails', async () => {
    const calls = setup({ status: ' M a.txt\n', checkoutFail: 'target' })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('already used by worktree')
    expect(calls).toContainEqual({ args: ['stash', 'pop'], cwd: ROOT })
  })

  it('surfaces a stash push failure before moving HEAD', async () => {
    const calls = setup({ status: ' M a.txt\n', stashPushFail: true })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('stash push failed')
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('reports the pop failure when the pull succeeded', async () => {
    setup({ status: ' M a.txt\n', popFail: true })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('CONFLICT')
  })

  it('combines pull and pop errors when both fail', async () => {
    setup({ status: ' M a.txt\n', pullFail: true, popFail: true })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("couldn't find remote ref")
    expect(res.stderr).toContain('Failed to restore stashed changes')
    expect(res.stderr).toContain('CONFLICT')
  })

  it('restores a detached HEAD by sha', async () => {
    const calls = setup({ headBranch: null, detachedSha: 'abc1234' })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['rev-parse', 'HEAD'], cwd: ROOT })
    expect(calls).toContainEqual({ args: ['checkout', 'abc1234'], cwd: ROOT })
  })

  it('pulls inside the holding worktree when another worktree has the branch', async () => {
    // The graph's own tree is dirty — it must stay untouched, no stash involved.
    const calls = setup({
      headBranch: 'feature',
      status: ' M local.txt\n',
      worktreePorcelain: PORCELAIN,
      holderPath: HOLDER,
    })

    const res = await pullBranch(CUR, 'main', 'rebase', undefined)

    expect(res.exitCode).toBe(0)
    expect(res.worktreePath).toBe(HOLDER)
    expect(res.worktreeName).toBe('repo')
    expect(calls).toContainEqual({ args: ['pull', '--rebase'], cwd: HOLDER })
    expect(calls.some((c) => c.args[0] === 'stash')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('refuses a dirty holding worktree without pulling', async () => {
    const calls = setup({
      headBranch: 'feature',
      worktreePorcelain: PORCELAIN,
      holderPath: HOLDER,
      holderStatus: ' M a.txt\n',
    })

    const res = await pullBranch(CUR, 'main', 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('uncommitted changes')
    expect(res.stderr).toContain(HOLDER)
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })

  it('surfaces a holder status failure', async () => {
    const calls = setup({
      headBranch: 'feature',
      worktreePorcelain: PORCELAIN,
      holderPath: HOLDER,
      holderStatusFail: true,
    })

    const res = await pullBranch(CUR, 'main', 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('unable to read worktree')
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })

  it('does not tag the result with a worktree when the pull there fails', async () => {
    setup({
      headBranch: 'feature',
      worktreePorcelain: PORCELAIN,
      holderPath: HOLDER,
      pullFail: true,
    })

    const res = await pullBranch(CUR, 'main', 'default', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.worktreePath).toBeUndefined()
    expect(res.worktreeName).toBeUndefined()
  })

  it('falls back to the checkout dance when the worktree list fails', async () => {
    const calls = setup({ status: ' M a.txt\n', worktreeListFail: true })

    const res = await pullBranch(ROOT, BRANCH, 'default', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['checkout', BRANCH], cwd: ROOT })
    expect(calls).toContainEqual({ args: ['stash', 'pop'], cwd: ROOT })
  })

  it('pulls in the holder without resolving HEAD when detached', async () => {
    // The holder lookup runs before the detached fallback — the restore ref is
    // never needed on the redirected path.
    const calls = setup({
      headBranch: null,
      worktreePorcelain: PORCELAIN,
      holderPath: HOLDER,
    })

    const res = await pullBranch(CUR, 'main', 'default', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['pull'], cwd: HOLDER })
    expect(calls.some((c) => c.args[0] === 'rev-parse')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })
})
