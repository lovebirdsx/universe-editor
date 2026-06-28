import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { getCommits } from '../gitGraphSource.js'

const ok = (stdout: string): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (): GitExecResult => ({ stdout: '', stderr: 'error', exitCode: 1 })

const FIELD = '\x1f'

/** One commit log record in the `%H..%s` format `getCommits` parses (NUL-joined). */
function logRecord(hash: string, parents: string, subject: string): string {
  return [hash, parents, 'Ann', 'ann@x.io', '1700000000', subject].join(FIELD)
}

/**
 * Route a `gitExec(args, cwd)` call to canned output by its leading subcommand.
 * `worktreePorcelain` is what `git worktree list --porcelain` returns.
 */
function setup(opts: { log: string[]; worktreePorcelain?: string | null }): void {
  execMock.mockImplementation((args: readonly string[]): Promise<GitExecResult> => {
    const [cmd, sub] = args
    if (cmd === 'log') return Promise.resolve(ok(opts.log.join('\0')))
    if (cmd === 'for-each-ref') return Promise.resolve(ok(''))
    if (cmd === 'rev-parse') return Promise.resolve(ok('aaa\n'))
    if (cmd === 'symbolic-ref') return Promise.resolve(ok('main\n'))
    if (cmd === 'status') return Promise.resolve(ok(''))
    if (cmd === 'stash') return Promise.resolve(ok(''))
    if (cmd === 'worktree' && sub === 'list') {
      if (opts.worktreePorcelain == null) return Promise.resolve(fail())
      return Promise.resolve(ok(opts.worktreePorcelain))
    }
    return Promise.resolve(ok(''))
  })
}

describe('getCommits — worktree aggregation', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('attaches linked worktrees to the commit their HEAD points at', async () => {
    setup({
      log: [logRecord('aaa', '', 'first'), logRecord('bbb', 'aaa', 'second')],
      worktreePorcelain: [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /repo.worktrees/feature',
        'HEAD bbb',
        'branch refs/heads/feature',
        '',
      ].join('\n'),
    })

    const res = await getCommits('/repo', { workspaceRoot: '/repo.worktrees/feature' })

    const main = res.commits.find((c) => c.hash === 'aaa')!
    const feature = res.commits.find((c) => c.hash === 'bbb')!

    expect(main.worktrees).toHaveLength(1)
    expect(main.worktrees[0]).toMatchObject({
      name: 'repo',
      branch: 'main',
      isMain: true,
      isCurrent: false,
    })

    expect(feature.worktrees).toHaveLength(1)
    expect(feature.worktrees[0]).toMatchObject({
      name: 'feature',
      branch: 'feature',
      isMain: false,
      isCurrent: true,
    })
  })

  it('attaches no worktrees when the repo has a single working tree', async () => {
    setup({
      log: [logRecord('aaa', '', 'first')],
      worktreePorcelain: ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main', ''].join('\n'),
    })

    const res = await getCommits('/repo', { workspaceRoot: '/repo' })
    expect(res.commits.every((c) => c.worktrees.length === 0)).toBe(true)
  })

  it('leaves worktrees empty when `git worktree list` fails', async () => {
    setup({ log: [logRecord('aaa', '', 'first')], worktreePorcelain: null })

    const res = await getCommits('/repo', { workspaceRoot: '/repo' })
    expect(res.commits[0]!.worktrees).toEqual([])
  })

  it('marks a detached worktree with a null branch', async () => {
    setup({
      log: [logRecord('aaa', '', 'first'), logRecord('bbb', 'aaa', 'second')],
      worktreePorcelain: [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /repo.worktrees/detached',
        'HEAD bbb',
        'detached',
        '',
      ].join('\n'),
    })

    const res = await getCommits('/repo', { workspaceRoot: '/repo' })
    const detached = res.commits.find((c) => c.hash === 'bbb')!
    expect(detached.worktrees[0]).toMatchObject({
      name: 'detached',
      branch: null,
      isCurrent: false,
    })
  })
})
