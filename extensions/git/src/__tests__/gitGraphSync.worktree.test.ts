import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { syncWorktreesToBranch } from '../gitGraphActions.js'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): GitExecResult => ({ stdout: '', stderr, exitCode: 1 })

interface Call {
  args: readonly string[]
  cwd: string
}

/**
 * Drive `gitExec(args, cwd)` from per-cwd canned responses. `status[cwd]` is the
 * `git status --porcelain` stdout (presence of text ⇒ dirty); `cherry[cwd]` is
 * the `git cherry <target> HEAD` stdout (a `+`-prefixed line ⇒ unmerged commit);
 * `reset[cwd]`, when present, overrides the reset result. Records every call.
 */
function setup(opts: {
  status?: Record<string, string>
  statusFail?: Set<string>
  cherry?: Record<string, string>
  reset?: Record<string, GitExecResult>
}): Call[] {
  const calls: Call[] = []
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'status') {
      if (opts.statusFail?.has(cwd)) return Promise.resolve(fail('status boom'))
      return Promise.resolve(ok(opts.status?.[cwd] ?? ''))
    }
    if (args[0] === 'cherry') return Promise.resolve(ok(opts.cherry?.[cwd] ?? ''))
    if (args[0] === 'reset') {
      return Promise.resolve(opts.reset?.[cwd] ?? ok())
    }
    return Promise.resolve(ok())
  })
  return calls
}

describe('syncWorktreesToBranch', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('resets each clean, fully-contained worktree to the target branch in its own cwd', async () => {
    const calls = setup({})
    const res = await syncWorktreesToBranch(
      'main',
      [
        { path: '/repo.wt/a', name: 'a' },
        { path: '/repo.wt/b', name: 'b' },
      ],
      undefined,
    )

    expect(res).toEqual({ synced: ['a', 'b'], skippedDirty: [], skippedUnmerged: [], failed: [] })
    const resets = calls.filter((c) => c.args[0] === 'reset')
    expect(resets).toEqual([
      { args: ['reset', '--hard', 'main'], cwd: '/repo.wt/a' },
      { args: ['reset', '--hard', 'main'], cwd: '/repo.wt/b' },
    ])
  })

  it('syncs a worktree whose commits are merged by patch-id (squash/rebase)', async () => {
    // `git cherry` reports only `-` lines: every worktree commit is already in the
    // target under a different hash. This must NOT be treated as unmerged.
    setup({ cherry: { '/repo.wt/a': '- 1111111111111111111111111111111111111111\n' } })
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual(['a'])
    expect(res.skippedUnmerged).toEqual([])
  })

  it('skips dirty worktrees without checking merge state or resetting them', async () => {
    const calls = setup({ status: { '/repo.wt/a': ' M file.ts\n' } })
    const res = await syncWorktreesToBranch(
      'main',
      [
        { path: '/repo.wt/a', name: 'a' },
        { path: '/repo.wt/b', name: 'b' },
      ],
      undefined,
    )

    expect(res.synced).toEqual(['b'])
    expect(res.skippedDirty).toEqual(['a'])
    expect(res.skippedUnmerged).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset' && c.cwd === '/repo.wt/a')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'cherry' && c.cwd === '/repo.wt/a')).toBe(false)
  })

  it('skips worktrees whose commits are not contained in the target', async () => {
    const calls = setup({
      cherry: { '/repo.wt/a': '+ 2222222222222222222222222222222222222222\n' },
    })
    const res = await syncWorktreesToBranch(
      'main',
      [
        { path: '/repo.wt/a', name: 'a' },
        { path: '/repo.wt/b', name: 'b' },
      ],
      undefined,
    )

    expect(res.synced).toEqual(['b'])
    expect(res.skippedUnmerged).toEqual(['a'])
    expect(res.skippedDirty).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset' && c.cwd === '/repo.wt/a')).toBe(false)
  })

  it('records a reset failure with the git error text', async () => {
    setup({ reset: { '/repo.wt/a': fail('fatal: ambiguous argument') } })
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual([])
    expect(res.skippedDirty).toEqual([])
    expect(res.skippedUnmerged).toEqual([])
    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: ambiguous argument' }])
  })

  it('records a status failure as a failure, not a skip', async () => {
    setup({ statusFail: new Set(['/repo.wt/a']) })
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.failed).toEqual([{ name: 'a', error: 'status boom' }])
    expect(res.synced).toEqual([])
    expect(res.skippedDirty).toEqual([])
    expect(res.skippedUnmerged).toEqual([])
  })
})
