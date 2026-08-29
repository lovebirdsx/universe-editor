import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock, submoduleMock, statMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  submoduleMock: vi.fn(),
  statMock: vi.fn(),
}))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))
// submoduleSync's own fs probing is covered by its unit test; here the outcome is
// a knob so the reset/submodule ordering and failure handling can be asserted.
// The mock still shells out through execMock so call ordering stays observable.
vi.mock('../submoduleSync.js', () => ({ updateSubmodulesIfPresent: submoduleMock }))
// Only the in-progress marker probe reaches the filesystem; nothing exists unless
// a test says so.
vi.mock('node:fs/promises', () => ({ stat: statMock }))

import { syncWorktreesToCommit } from '../worktreeSync.js'

const NEW_HEAD = 'b'.repeat(40)
const OLD_HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'c'.repeat(40)

const ROOT = '/repo'
const WT_A = '/repo.worktrees/a'
const WT_B = '/repo.worktrees/b'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, exitCode = 1): GitExecResult => ({ stdout: '', stderr, exitCode })

interface Call {
  args: readonly string[]
  cwd: string
}

/** Where `rev-parse --git-path` points for a worktree, mirroring git's own layout. */
const gitDirOf = (cwd: string): string => `${cwd}/.git/`

/** Build `git worktree list --porcelain` output from records. */
function porcelain(
  entries: readonly { path: string; branch?: string; head?: string; bare?: boolean }[],
): string {
  return entries
    .map((e) => {
      const lines = [`worktree ${e.path}`]
      if (e.bare) {
        lines.push('bare')
      } else {
        lines.push(`HEAD ${e.head ?? OLD_HEAD}`)
        lines.push(e.branch ? `branch refs/heads/${e.branch}` : 'detached')
      }
      return `${lines.join('\n')}\n`
    })
    .join('\n')
}

/**
 * Drive `gitExec(args, cwd)` from per-cwd canned responses. `status[cwd]` is the
 * `git status --porcelain` stdout (text ⇒ dirty); `head[cwd]` is what
 * `rev-parse HEAD` resolves to in that worktree; `ancestor[cwd]` overrides the
 * `merge-base --is-ancestor` result (exit 1 ⇒ diverged). Records every call.
 */
function setup(opts: {
  list?: string
  listResult?: GitExecResult
  status?: Record<string, string>
  statusFail?: Record<string, GitExecResult>
  head?: Record<string, string>
  headFail?: Record<string, GitExecResult>
  ancestor?: Record<string, GitExecResult>
  reset?: Record<string, GitExecResult>
}): Call[] {
  const calls: Call[] = []
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'worktree') return Promise.resolve(opts.listResult ?? ok(opts.list ?? ''))
    if (args[0] === 'status') {
      const failure = opts.statusFail?.[cwd]
      return Promise.resolve(failure ?? ok(opts.status?.[cwd] ?? ''))
    }
    if (args[0] === 'rev-parse') {
      if (args[1] === '--git-path') return Promise.resolve(ok(`${gitDirOf(cwd)}x\n`))
      const failure = opts.headFail?.[cwd]
      return Promise.resolve(failure ?? ok(`${opts.head?.[cwd] ?? OLD_HEAD}\n`))
    }
    // The ancestry test runs in the pulling repo, so key it off the worktree
    // path carried in argv rather than cwd.
    if (args[0] === 'merge-base') {
      const subject = args[2] ?? ''
      const forWt = Object.entries(opts.ancestor ?? {}).find(
        ([wt]) => (opts.head?.[wt] ?? OLD_HEAD) === subject,
      )
      return Promise.resolve(forWt?.[1] ?? ok())
    }
    if (args[0] === 'reset') return Promise.resolve(opts.reset?.[cwd] ?? ok())
    return Promise.resolve(ok())
  })
  return calls
}

describe('syncWorktreesToCommit', () => {
  beforeEach(() => {
    execMock.mockReset()
    submoduleMock.mockReset()
    submoduleMock.mockResolvedValue({ ran: false })
    statMock.mockReset()
    statMock.mockRejectedValue(new Error('ENOENT'))
  })
  afterEach(() => vi.restoreAllMocks())

  /** Plant in-progress operation markers: `markers[worktreePath] = ['MERGE_HEAD']`. */
  const withMarkers = (markers: Record<string, readonly string[]>): void => {
    statMock.mockImplementation((path: string) => {
      const hit = Object.entries(markers).some(([wt, files]) =>
        files.some((f) => path === `${gitDirOf(wt)}${f}`),
      )
      return hit ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'))
    })
  }

  /** Make the submodule step run for real (via execMock) so ordering is visible. */
  const withSubmodules = (result?: GitExecResult): void => {
    submoduleMock.mockImplementation(
      async (root: string, log: ((msg: string) => void) | undefined) => ({
        ran: true,
        result:
          result ?? (await execMock(['submodule', 'update', '--init', '--recursive'], root, log)),
      }),
    )
  }

  it('fast-forwards a clean detached worktree in its own directory', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual(['a'])
    expect(res.syncedBranches).toEqual([])
    expect(calls).toContainEqual({ args: ['reset', '--hard', NEW_HEAD], cwd: WT_A })
  })

  it('fast-forwards a branch worktree and reports the branch that moved', async () => {
    setup({
      list: porcelain([
        { path: ROOT, branch: 'main', head: NEW_HEAD },
        { path: WT_A, branch: 'feature' },
      ]),
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedBranches).toEqual([{ name: 'a', branch: 'feature' }])
    expect(res.syncedDetached).toEqual([])
  })

  it('excludes the worktree the pull ran in and bare worktrees', async () => {
    const calls = setup({
      list: porcelain([
        { path: ROOT, branch: 'main', head: NEW_HEAD },
        { path: '/repo.bare', bare: true },
      ]),
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual([])
    expect(res.syncedBranches).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('matches the current worktree regardless of path separator style', async () => {
    const calls = setup({
      list: porcelain([{ path: 'C:/repo', branch: 'main', head: NEW_HEAD }]),
    })

    await syncWorktreesToCommit(NEW_HEAD, 'C:\\repo\\', undefined)

    expect(calls.some((c) => c.args[0] === 'status')).toBe(false)
  })

  it('skips a dirty worktree without resolving its HEAD or resetting it', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
      status: { [WT_A]: ' M file.ts\n' },
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.skippedDirty).toEqual(['a'])
    expect(res.syncedDetached).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'rev-parse')).toBe(false)
  })

  // A paused rebase leaves a clean tree, so the dirty check above waves it through
  // and only the marker probe stands between it and a destructive reset.
  it.each([
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ])('skips a clean worktree halted mid-operation (%s)', async (marker) => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
    })
    withMarkers({ [WT_A]: [marker] })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.skippedInProgress).toEqual(['a'])
    expect(res.skippedDirty).toEqual([])
    expect(res.syncedDetached).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('keeps one worktree from sinking the rest when its git invocation throws', async () => {
    const list = porcelain([
      { path: ROOT, branch: 'main', head: NEW_HEAD },
      { path: WT_A },
      { path: WT_B },
    ])
    execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
      if (args[0] === 'worktree') return Promise.resolve(ok(list))
      if (cwd === WT_A) return Promise.reject(new Error('spawn ENOENT'))
      if (args[0] === 'rev-parse' && args[1] !== '--git-path') {
        return Promise.resolve(ok(`${OLD_HEAD}\n`))
      }
      if (args[0] === 'rev-parse') return Promise.resolve(ok(`${gitDirOf(cwd)}x\n`))
      return Promise.resolve(ok())
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.failed).toEqual([{ name: 'a', error: 'spawn ENOENT' }])
    expect(res.syncedDetached).toEqual(['b'])
  })

  it('skips a worktree carrying commits of its own', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
      head: { [WT_A]: OTHER_HEAD },
      ancestor: { [WT_A]: fail('') },
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.skippedDiverged).toEqual(['a'])
    expect(res.syncedDetached).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('runs the ancestry check in the pulling repo, not the worktree', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
    })

    await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(calls).toContainEqual({
      args: ['merge-base', '--is-ancestor', OLD_HEAD, NEW_HEAD],
      cwd: ROOT,
    })
  })

  it('counts a worktree already at the new commit as synced without resetting it', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
      head: { [WT_A]: NEW_HEAD },
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual(['a'])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'merge-base')).toBe(false)
  })

  it('updates submodules in the worktree after resetting it', async () => {
    const calls = setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
    })
    withSubmodules()

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual(['a'])
    const order = calls.filter((c) => c.cwd === WT_A).map((c) => c.args[0])
    expect(order.indexOf('submodule')).toBeGreaterThan(order.indexOf('reset'))
    expect(calls).toContainEqual({
      args: ['submodule', 'update', '--init', '--recursive'],
      cwd: WT_A,
    })
  })

  it('records a failed submodule update as a failure, not a sync', async () => {
    setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
    })
    withSubmodules(fail('fatal: submodule update failed'))

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual([])
    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: submodule update failed' }])
  })

  it.each([
    ['status', { statusFail: { [WT_A]: fail('status boom') } }, 'status boom'],
    ['rev-parse', { headFail: { [WT_A]: fail('rev-parse boom') } }, 'rev-parse boom'],
    ['reset', { reset: { [WT_A]: fail('reset boom') } }, 'reset boom'],
  ])('records a %s failure with the git error text', async (_name, extra, expected) => {
    setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
      ...extra,
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.failed).toEqual([{ name: 'a', error: expected }])
    expect(res.syncedDetached).toEqual([])
    expect(res.skippedDirty).toEqual([])
    expect(res.skippedDiverged).toEqual([])
  })

  it('treats a merge-base error (exit > 1) as a failure, not a diverged skip', async () => {
    setup({
      list: porcelain([{ path: ROOT, branch: 'main', head: NEW_HEAD }, { path: WT_A }]),
      ancestor: { [WT_A]: fail('fatal: not a valid object name', 128) },
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: not a valid object name' }])
    expect(res.skippedDiverged).toEqual([])
  })

  it('returns an empty result when listing worktrees fails', async () => {
    const calls = setup({ listResult: fail('fatal: not a git repository') })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res).toEqual({
      syncedDetached: [],
      syncedBranches: [],
      skippedDirty: [],
      skippedInProgress: [],
      skippedDiverged: [],
      failed: [],
    })
    expect(calls.filter((c) => c.args[0] !== 'worktree')).toEqual([])
  })

  it('syncs worktrees concurrently and keeps buckets in input order', async () => {
    // Worktree a's status resolves only once b's reset has been issued: a serial
    // implementation would never reach b and would deadlock here.
    let releaseA: ((r: GitExecResult) => void) | undefined
    const gate = new Promise<GitExecResult>((resolve) => {
      releaseA = resolve
    })
    const list = porcelain([
      { path: ROOT, branch: 'main', head: NEW_HEAD },
      { path: WT_A },
      { path: WT_B },
    ])
    execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
      if (args[0] === 'worktree') return Promise.resolve(ok(list))
      if (args[0] === 'status' && cwd === WT_A) return gate
      if (args[0] === 'reset' && cwd === WT_B) {
        releaseA?.(ok())
        return Promise.resolve(ok())
      }
      if (args[0] === 'rev-parse') return Promise.resolve(ok(`${OLD_HEAD}\n`))
      return Promise.resolve(ok())
    })

    const res = await syncWorktreesToCommit(NEW_HEAD, ROOT, undefined)

    expect(res.syncedDetached).toEqual(['a', 'b'])
  }, 5000)
})
