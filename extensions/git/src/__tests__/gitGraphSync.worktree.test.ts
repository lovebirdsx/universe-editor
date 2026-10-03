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
 * `git status --porcelain` stdout (presence of text ⇒ dirty); `reset[cwd]`, when
 * present, overrides the reset result. `log` is keyed by `cwd` → `args.join(' ')`
 * for `git log`; `mergeBase`/`mergeBaseUnrelated`/`mergeBaseFail` drive the `git
 * merge-base` probe per cwd. Records every call.
 */
function setup(opts: {
  status?: Record<string, string>
  statusFail?: Set<string>
  reset?: Record<string, GitExecResult>
  submoduleFail?: Record<string, string>
  log?: Record<string, Record<string, string>>
  logFail?: Record<string, Record<string, string>>
  mergeBase?: Record<string, string>
  mergeBaseUnrelated?: Set<string>
  mergeBaseFail?: Set<string>
}): Call[] {
  const calls: Call[] = []
  execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
    calls.push({ args, cwd })
    if (args[0] === 'status') {
      if (opts.statusFail?.has(cwd)) return Promise.resolve(fail('status boom'))
      return Promise.resolve(ok(opts.status?.[cwd] ?? ''))
    }
    if (args[0] === 'reset') {
      return Promise.resolve(opts.reset?.[cwd] ?? ok())
    }
    if (args[0] === 'submodule') {
      const errMsg = opts.submoduleFail?.[cwd]
      return Promise.resolve(errMsg ? fail(errMsg) : ok())
    }
    if (args[0] === 'log') {
      const key = args.join(' ')
      const err = opts.logFail?.[cwd]?.[key]
      if (err !== undefined) return Promise.resolve(fail(err))
      return Promise.resolve(ok(opts.log?.[cwd]?.[key] ?? ''))
    }
    if (args[0] === 'merge-base') {
      if (opts.mergeBaseFail?.has(cwd)) {
        const res = fail('merge-base boom')
        return Promise.resolve({ ...res, exitCode: 128 })
      }
      if (opts.mergeBaseUnrelated?.has(cwd)) return Promise.resolve(fail('no common ancestor'))
      return Promise.resolve(ok(opts.mergeBase?.[cwd] ?? ''))
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

    expect(res).toEqual({
      synced: ['a', 'b'],
      skippedDirty: [],
      skippedUnmatchedMessages: [],
      failed: [],
    })
    const resets = calls.filter((c) => c.args[0] === 'reset')
    expect(resets).toEqual([
      { args: ['reset', '--hard', 'main'], cwd: '/repo.wt/a' },
      { args: ['reset', '--hard', 'main'], cwd: '/repo.wt/b' },
    ])
  })

  it('syncs a clean worktree whose orphan-to-be commits are covered by the target', async () => {
    // The worktree's commits are not in the target by hash or patch-id (a squash /
    // cherry-pick landed them under different hashes), but every subject they carry
    // is present in the target's own history, so the reset drops nothing.
    const calls = setup({
      log: {
        '/repo.wt/a': {
          'log --format=%s main..HEAD': 'dc2\ndc3\n',
          'log --format=%s abc123..main': 'dc1\ndc2\ndc3\n',
        },
      },
      mergeBase: { '/repo.wt/a': 'abc123' },
    })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual(['a'])
    expect(res.skippedUnmatchedMessages).toEqual([])
    expect(calls).toContainEqual({
      args: ['log', '--format=%s', 'main..HEAD'],
      cwd: '/repo.wt/a',
    })
    expect(calls).toContainEqual({ args: ['merge-base', 'main', 'HEAD'], cwd: '/repo.wt/a' })
    expect(calls).toContainEqual({
      args: ['log', '--format=%s', 'abc123..main'],
      cwd: '/repo.wt/a',
    })
    expect(calls).toContainEqual({ args: ['reset', '--hard', 'main'], cwd: '/repo.wt/a' })
  })

  it('skips dirty worktrees without probing their commits or resetting them', async () => {
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
    expect(res.skippedUnmatchedMessages).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset' && c.cwd === '/repo.wt/a')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'log' && c.cwd === '/repo.wt/a')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'merge-base' && c.cwd === '/repo.wt/a')).toBe(false)
  })

  it('skips a worktree whose orphan-to-be commit message is missing from the target', async () => {
    const calls = setup({
      log: {
        '/repo.wt/a': {
          'log --format=%s main..HEAD': 'dc2\ndc31\n',
          'log --format=%s abc123..main': 'dc1\ndc2\ndc3\n',
        },
      },
      mergeBase: { '/repo.wt/a': 'abc123' },
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
    expect(res.skippedUnmatchedMessages).toEqual(['a'])
    expect(res.skippedDirty).toEqual([])
    expect(calls.some((c) => c.args[0] === 'reset' && c.cwd === '/repo.wt/a')).toBe(false)
  })

  it('force-syncs a clean worktree without probing its commit messages', async () => {
    // Same uncovered commit as above (dc31 is nowhere in the target), but force
    // mode discards it instead of refusing — and never pays for the probe.
    const calls = setup({
      log: {
        '/repo.wt/a': {
          'log --format=%s main..HEAD': 'dc31\n',
          'log --format=%s abc123..main': 'dc1\ndc2\n',
        },
      },
      mergeBase: { '/repo.wt/a': 'abc123' },
    })

    const res = await syncWorktreesToBranch(
      'main',
      [{ path: '/repo.wt/a', name: 'a' }],
      undefined,
      true,
    )

    expect(res).toEqual({
      synced: ['a'],
      skippedDirty: [],
      skippedUnmatchedMessages: [],
      failed: [],
    })
    expect(calls.some((c) => c.args[0] === 'log' || c.args[0] === 'merge-base')).toBe(false)
    expect(calls).toContainEqual({ args: ['reset', '--hard', 'main'], cwd: '/repo.wt/a' })
  })

  it('still skips dirty worktrees in force mode', async () => {
    const calls = setup({ status: { '/repo.wt/a': ' M file.ts\n' } })

    const res = await syncWorktreesToBranch(
      'main',
      [{ path: '/repo.wt/a', name: 'a' }],
      undefined,
      true,
    )

    expect(res.synced).toEqual([])
    expect(res.skippedDirty).toEqual(['a'])
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('syncs without probing messages when the worktree has no commits beyond the target', async () => {
    const calls = setup({})

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual(['a'])
    expect(calls.some((c) => c.args[0] === 'merge-base')).toBe(false)
    expect(calls).toContainEqual({ args: ['reset', '--hard', 'main'], cwd: '/repo.wt/a' })
  })

  it('falls back to the target full history when there is no common ancestor', async () => {
    const calls = setup({
      log: {
        '/repo.wt/a': {
          'log --format=%s main..HEAD': 'dc2\n',
          'log --format=%s main': 'dc1\ndc2\n',
        },
      },
      mergeBaseUnrelated: new Set(['/repo.wt/a']),
    })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual(['a'])
    expect(calls).toContainEqual({ args: ['log', '--format=%s', 'main'], cwd: '/repo.wt/a' })
    expect(calls).not.toContainEqual({
      args: ['log', '--format=%s', 'abc123..main'],
      cwd: '/repo.wt/a',
    })
  })

  it('refuses when a unique commit has an empty subject', async () => {
    const calls = setup({
      log: {
        '/repo.wt/a': {
          'log --format=%s main..HEAD': 'dc2\n\n',
          'log --format=%s abc123..main': 'dc1\ndc2\n',
        },
      },
      mergeBase: { '/repo.wt/a': 'abc123' },
    })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual([])
    expect(res.skippedUnmatchedMessages).toEqual(['a'])
    expect(calls.some((c) => c.args[0] === 'reset' && c.cwd === '/repo.wt/a')).toBe(false)
  })

  it('records a unique-log failure as a failure, not a skip', async () => {
    setup({ logFail: { '/repo.wt/a': { 'log --format=%s main..HEAD': 'fatal: bad revision' } } })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual([])
    expect(res.skippedUnmatchedMessages).toEqual([])
    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: bad revision' }])
  })

  it('records an unexpected merge-base failure as a failure', async () => {
    setup({
      log: { '/repo.wt/a': { 'log --format=%s main..HEAD': 'dc2\n' } },
      mergeBaseFail: new Set(['/repo.wt/a']),
    })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual([])
    expect(res.failed).toEqual([{ name: 'a', error: 'merge-base boom' }])
  })

  it('records a target-side log failure as a failure', async () => {
    setup({
      log: { '/repo.wt/a': { 'log --format=%s main..HEAD': 'dc2\n' } },
      logFail: { '/repo.wt/a': { 'log --format=%s abc123..main': 'fatal: bad object' } },
      mergeBase: { '/repo.wt/a': 'abc123' },
    })

    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual([])
    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: bad object' }])
  })

  it('syncs worktrees concurrently and keeps buckets in input order', async () => {
    // Worktree a's `status` resolves only after worktree b's `reset` has been
    // issued: a serial implementation would never reach b and deadlock here,
    // so completing at all proves the pipelines overlap.
    let releaseA: ((r: GitExecResult) => void) | undefined
    const gate = new Promise<GitExecResult>((resolve) => {
      releaseA = resolve
    })
    execMock.mockImplementation((args: readonly string[], cwd: string): Promise<GitExecResult> => {
      if (args[0] === 'status' && cwd === '/repo.wt/a') return gate
      if (args[0] === 'reset' && cwd === '/repo.wt/b') {
        releaseA?.(ok())
        return Promise.resolve(ok())
      }
      return Promise.resolve(ok())
    })

    const res = await syncWorktreesToBranch(
      'main',
      [
        { path: '/repo.wt/a', name: 'a' },
        { path: '/repo.wt/b', name: 'b' },
      ],
      undefined,
    )

    // b finished first, but the summary still lists a before b (input order).
    expect(res.synced).toEqual(['a', 'b'])
  }, 5000)

  it('records a reset failure with the git error text', async () => {
    setup({ reset: { '/repo.wt/a': fail('fatal: ambiguous argument') } })
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res).toEqual({
      synced: [],
      skippedDirty: [],
      skippedUnmatchedMessages: [],
      failed: [{ name: 'a', error: 'fatal: ambiguous argument' }],
    })
  })

  it('records a status failure as a failure, not a skip', async () => {
    setup({ statusFail: new Set(['/repo.wt/a']) })
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.failed).toEqual([{ name: 'a', error: 'status boom' }])
    expect(res.synced).toEqual([])
    expect(res.skippedDirty).toEqual([])
    expect(res.skippedUnmatchedMessages).toEqual([])
  })

  it('runs submodule update after reset and counts the worktree as synced when it succeeds', async () => {
    const calls = setup({})
    const res = await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(res.synced).toEqual(['a'])
    expect(res.failed).toEqual([])
    const subCalls = calls.filter((c) => c.args[0] === 'submodule')
    expect(subCalls).toEqual([
      { args: ['submodule', 'update', '--init', '--recursive'], cwd: '/repo.wt/a' },
    ])
  })

  it('moves a worktree to failed when submodule update fails after a successful reset', async () => {
    setup({ submoduleFail: { '/repo.wt/a': 'fatal: submodule init failed' } })
    const res = await syncWorktreesToBranch(
      'main',
      [
        { path: '/repo.wt/a', name: 'a' },
        { path: '/repo.wt/b', name: 'b' },
      ],
      undefined,
    )

    expect(res.synced).toEqual(['b'])
    expect(res.failed).toEqual([{ name: 'a', error: 'fatal: submodule init failed' }])
    expect(res.skippedDirty).toEqual([])
    expect(res.skippedUnmatchedMessages).toEqual([])
  })

  it('never shells out to git cherry', async () => {
    // The guard used to fall back to a patch-id check in normal mode; the subject
    // comparison replaced it, and nothing should resurrect the extra round-trip.
    const calls = setup({})
    await syncWorktreesToBranch('main', [{ path: '/repo.wt/a', name: 'a' }], undefined)

    expect(calls.some((c) => c.args[0] === 'cherry')).toBe(false)
  })
})
