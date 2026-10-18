import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitExecResult } from '../gitService.js'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))

vi.mock('../gitService.js', () => ({ gitExec: execMock }))

import { countCommits } from '../gitGraphSource.js'

const ok = (stdout: string): GitExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (): GitExecResult => ({ stdout: '', stderr: 'error', exitCode: 128 })

function revListArgs(): readonly string[] | undefined {
  return execMock.mock.calls.find((c) => c[0]?.[0] === 'rev-list')?.[0]
}

describe('countCommits', () => {
  beforeEach(() => execMock.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('counts the same revset as the log, honouring includeRemotes', async () => {
    execMock.mockImplementation((args: readonly string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(ok('head\n'))
      if (args[0] === 'rev-list') return Promise.resolve(ok('2372\n'))
      return Promise.resolve(ok(''))
    })

    await expect(countCommits('/repo', { includeRemotes: true })).resolves.toBe(2372)
    expect(revListArgs()).toEqual([
      'rev-list',
      '--count',
      '--branches',
      '--tags',
      '--remotes',
      'HEAD',
    ])

    execMock.mockClear()
    execMock.mockImplementation((args: readonly string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(ok('head\n'))
      if (args[0] === 'rev-list') return Promise.resolve(ok('12\n'))
      return Promise.resolve(ok(''))
    })
    await expect(countCommits('/repo', { includeRemotes: false })).resolves.toBe(12)
    expect(revListArgs()).toEqual(['rev-list', '--count', '--branches', '--tags', 'HEAD'])
  })

  it('returns 0 for an unborn repository without walking history', async () => {
    execMock.mockImplementation((args: readonly string[]) =>
      Promise.resolve(args[0] === 'rev-parse' ? fail() : ok('99\n')),
    )
    await expect(countCommits('/repo', {})).resolves.toBe(0)
    expect(execMock.mock.calls.some((c) => c[0]?.[0] === 'rev-list')).toBe(false)
  })

  it('returns 0 when git prints a non-numeric count', async () => {
    execMock.mockImplementation((args: readonly string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(ok('head\n'))
      if (args[0] === 'rev-list') return Promise.resolve(ok('not-a-number\n'))
      return Promise.resolve(ok(''))
    })
    await expect(countCommits('/repo', {})).resolves.toBe(0)
  })
})
