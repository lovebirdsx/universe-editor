import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { cherryPickToBranch } from '../gitGraphActions.js'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): GitExecResult => ({ stdout: '', stderr, exitCode: 1 })

interface Call {
  args: readonly string[]
  cwd: string
}

/**
 * Drive `gitExec(args, cwd)` from canned responses keyed on the first arg.
 * `worktreePorcelain` feeds `git worktree list --porcelain`; `status[cwd]` marks a
 * dirty tree; `pickFail` makes `cherry-pick` fail (conflict); everything else is ok.
 */
function setup(opts: {
  worktreePorcelain?: string
  status?: Record<string, string>
  headName?: string
  pickFail?: boolean
}): Call[] {
  const calls: Call[] = []
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'worktree') return Promise.resolve(ok(opts.worktreePorcelain ?? ''))
    if (args[0] === 'status') return Promise.resolve(ok(opts.status?.[cwd] ?? ''))
    if (args[0] === 'symbolic-ref') return Promise.resolve(ok(opts.headName ?? ''))
    if (args[0] === 'rev-parse') return Promise.resolve(ok('deadbeef'))
    if (args[0] === 'cherry-pick') {
      return Promise.resolve(opts.pickFail ? fail('error: could not apply') : ok())
    }
    return Promise.resolve(ok())
  })
  return calls
}

const CUR = '/repo.wt/feature'
const HASH = '1234567890123456789012345678901234567890'

describe('cherryPickToBranch', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('cherry-picks inside the holding worktree when the target is checked out elsewhere', async () => {
    // The classic failing case: `main` is held by the main worktree while we work
    // in a linked one. We must NOT `checkout main` here (git rejects it) — instead
    // run the pick in the main worktree's own directory.
    const calls = setup({
      worktreePorcelain: [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        `worktree ${CUR}`,
        'HEAD bbb',
        'branch refs/heads/feature',
        '',
      ].join('\n'),
    })

    const res = await cherryPickToBranch(CUR, HASH, 'main', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['cherry-pick', HASH], cwd: '/repo' })
    // Never checks out the target in the current worktree.
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('refuses when the holding worktree is dirty, without applying anything', async () => {
    const calls = setup({
      worktreePorcelain: ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main', ''].join('\n'),
      status: { '/repo': ' M file.ts\n' },
    })

    const res = await cherryPickToBranch(CUR, HASH, 'main', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('/repo')
    expect(calls.some((c) => c.args[0] === 'cherry-pick')).toBe(false)
  })

  it('picks in place (no checkout) when the target is the current worktree branch', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/feature', ''].join(
        '\n',
      ),
    })

    const res = await cherryPickToBranch(CUR, HASH, 'feature', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['cherry-pick', HASH], cwd: CUR })
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('checks out, picks, then restores HEAD when the target is not checked out anywhere', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/feature', ''].join(
        '\n',
      ),
      headName: 'feature',
    })

    const res = await cherryPickToBranch(CUR, HASH, 'release', undefined)

    expect(res.exitCode).toBe(0)
    const checkouts = calls.filter((c) => c.args[0] === 'checkout').map((c) => c.args)
    expect(checkouts).toEqual([
      ['checkout', 'release'],
      ['checkout', 'feature'],
    ])
    expect(calls).toContainEqual({ args: ['cherry-pick', HASH], cwd: CUR })
  })

  it('leaves HEAD on the target (no restore) when the pick conflicts on the fallback path', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/feature', ''].join(
        '\n',
      ),
      headName: 'feature',
      pickFail: true,
    })

    const res = await cherryPickToBranch(CUR, HASH, 'release', undefined)

    expect(res.exitCode).toBe(1)
    const checkouts = calls.filter((c) => c.args[0] === 'checkout').map((c) => c.args)
    expect(checkouts).toEqual([['checkout', 'release']]) // no restore checkout
  })
})
