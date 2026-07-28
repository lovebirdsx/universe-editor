import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { resetBranchToRemote } from '../gitGraphActions.js'

const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): GitExecResult => ({ stdout: '', stderr, exitCode: 1 })

interface Call {
  args: readonly string[]
  cwd: string
}

/** Same canned-response harness as the cherryPickToBranch tests. */
function setup(opts: {
  worktreePorcelain?: string
  status?: Record<string, string>
  branchFail?: boolean
  resetFail?: boolean
}): Call[] {
  const calls: Call[] = []
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'worktree') return Promise.resolve(ok(opts.worktreePorcelain ?? ''))
    if (args[0] === 'status') return Promise.resolve(ok(opts.status?.[cwd] ?? ''))
    if (args[0] === 'branch' && args[1] === '-f' && opts.branchFail) {
      return Promise.resolve(fail('fatal: cannot force update'))
    }
    if (args[0] === 'reset' && opts.resetFail) {
      return Promise.resolve(fail('fatal: Could not parse object'))
    }
    return Promise.resolve(ok())
  })
  return calls
}

const CUR = '/repo.wt/feature'
const REMOTE = 'origin/development'

describe('resetBranchToRemote', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('force-moves, sets upstream, then checks out when no worktree holds the branch', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/feature', ''].join(
        '\n',
      ),
    })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({
      args: ['branch', '-f', 'development', REMOTE],
      cwd: CUR,
    })
    expect(calls).toContainEqual({
      args: ['branch', '--set-upstream-to', REMOTE, 'development'],
      cwd: CUR,
    })
    expect(calls).toContainEqual({ args: ['checkout', 'development'], cwd: CUR })
  })

  it('resets in place when the current worktree holds the branch', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/development', ''].join(
        '\n',
      ),
    })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['reset', '--hard', REMOTE], cwd: CUR })
    expect(calls).toContainEqual({
      args: ['branch', '--set-upstream-to', REMOTE, 'development'],
      cwd: CUR,
    })
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('resets inside the holding worktree when another worktree holds the branch', async () => {
    const calls = setup({
      worktreePorcelain: [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/development',
        '',
        `worktree ${CUR}`,
        'HEAD bbb',
        'branch refs/heads/feature',
        '',
      ].join('\n'),
    })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(0)
    expect(calls).toContainEqual({ args: ['reset', '--hard', REMOTE], cwd: '/repo' })
    expect(calls.some((c) => c.args[1] === '-f')).toBe(false)
  })

  it('refuses when the holding worktree is dirty, without resetting anything', async () => {
    const calls = setup({
      worktreePorcelain: ['worktree /repo', 'HEAD aaa', 'branch refs/heads/development', ''].join(
        '\n',
      ),
      status: { '/repo': ' M file.ts\n' },
    })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('/repo')
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
    expect(calls.some((c) => c.args[1] === '-f')).toBe(false)
  })

  it('surfaces the branch -f failure without checking out', async () => {
    const calls = setup({ worktreePorcelain: '', branchFail: true })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('cannot force update')
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('surfaces the reset failure without touching upstream', async () => {
    const calls = setup({
      worktreePorcelain: [`worktree ${CUR}`, 'HEAD bbb', 'branch refs/heads/development', ''].join(
        '\n',
      ),
      resetFail: true,
    })

    const res = await resetBranchToRemote(CUR, REMOTE, 'development', undefined)

    expect(res.exitCode).toBe(1)
    expect(calls.some((c) => c.args[1] === '--set-upstream-to')).toBe(false)
  })
})
