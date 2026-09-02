/**
 * Unit tests for `reconcileScanBudget` — the pre-scan budget prediction of the
 * background reconcile scan. Locks in:
 *  1. The warm prior (measured elapsed ms) decides alone, in both directions:
 *     over the ceiling splits, at/under it scans — a size estimate never
 *     overrides a measurement.
 *  2. The cold prior (local file count) splits only strictly above the
 *     exported threshold; at/under it (or absent) scans.
 *  3. No priors → scan.
 *  4. `countLocalFilesUpTo` counts files (not directories), stops the walk the
 *     moment the ceiling is exceeded (never visiting the remaining siblings),
 *     and degrades to undefined on any readdir failure, on the directory
 *     budget, or on an abort signal. Symlinked/junction directories count as
 *     files and are never descended.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const readdirMock = vi.hoisted(() =>
  vi.fn<
    (
      dir: string,
    ) => Promise<Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>>
  >(),
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: unknown[]) => readdirMock(...(args as [string])),
  }
})

const {
  RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES,
  RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD,
  predictReconcileScanBatch,
  countLocalFilesUpTo,
} = await import('../reconcileScanBudget.js')

const CEILING = 10_000

function file(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => false, isSymbolicLink: () => false }
}
function dir(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => true, isSymbolicLink: () => false }
}
/** A Windows-junction-shaped entry: readdir reports it as a directory that is
 *  also a reparse point — the walk must count it, never follow it. */
function junction(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => true, isSymbolicLink: () => true }
}

describe('predictReconcileScanBatch', () => {
  it('splits when the warm prior exceeds the ceiling', () => {
    expect(predictReconcileScanBatch({ elapsedMs: CEILING + 1 }, CEILING)).toEqual({
      action: 'split',
      reason: 'elapsedMs',
      value: CEILING + 1,
    })
  })

  it('scans when the warm prior equals the ceiling exactly', () => {
    expect(predictReconcileScanBatch({ elapsedMs: CEILING }, CEILING)).toEqual({ action: 'scan' })
  })

  it('scans when the warm prior is under the ceiling', () => {
    expect(predictReconcileScanBatch({ elapsedMs: CEILING - 1 }, CEILING)).toEqual({
      action: 'scan',
    })
  })

  it('lets the warm prior override a contradictory file count in both directions', () => {
    // Measured fast — a huge size estimate must not force a split.
    expect(
      predictReconcileScanBatch(
        { elapsedMs: 1, fileCount: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD + 1 },
        CEILING,
      ),
    ).toEqual({ action: 'scan' })
    // Measured slow — a tiny size estimate must not rescue the batch.
    expect(predictReconcileScanBatch({ elapsedMs: CEILING + 1, fileCount: 0 }, CEILING)).toEqual({
      action: 'split',
      reason: 'elapsedMs',
      value: CEILING + 1,
    })
  })

  it('splits on a cold file count strictly above the threshold', () => {
    expect(
      predictReconcileScanBatch(
        { fileCount: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD + 1 },
        CEILING,
      ),
    ).toEqual({
      action: 'split',
      reason: 'fileCount',
      value: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD + 1,
    })
  })

  it('scans when the cold file count equals the threshold exactly', () => {
    expect(
      predictReconcileScanBatch(
        { fileCount: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD },
        CEILING,
      ),
    ).toEqual({ action: 'scan' })
  })

  it('scans when the cold file count is under the threshold', () => {
    expect(predictReconcileScanBatch({ fileCount: 42 }, CEILING)).toEqual({ action: 'scan' })
  })

  it('scans with no priors at all', () => {
    expect(predictReconcileScanBatch({}, CEILING)).toEqual({ action: 'scan' })
  })
})

describe('countLocalFilesUpTo', () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it('counts files recursively, excluding directories', async () => {
    readdirMock.mockImplementation(async (d: string) => {
      if (d === '/root') return [dir('a'), file('x.txt')]
      // Subdirectory paths come from `readdir` + `path.join` — compare with
      // the same helper, never a hand-built separator.
      if (d === join('/root', 'a')) return [file('y.txt'), file('z.txt')]
      return []
    })
    expect(await countLocalFilesUpTo('/root', 100)).toBe(3)
  })

  it('returns 0 for an empty directory', async () => {
    readdirMock.mockImplementation(async () => [])
    expect(await countLocalFilesUpTo('/root', 100)).toBe(0)
  })

  it('stops inside a single listing once the ceiling is exceeded', async () => {
    // One flat directory: ceiling + 1 files. The walk stops at file
    // `ceiling + 1` and never descends anywhere else — the listing is read
    // exactly once.
    const entries = [dir('sub'), ...Array.from({ length: 6 }, (_, i) => file(`f${i}`))]
    readdirMock.mockImplementation(async () => entries)
    expect(await countLocalFilesUpTo('/root', 5)).toBe(6)
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  it('stops the walk once a subtree exceeds the ceiling, without finishing the remaining siblings', async () => {
    // `/root/big` alone exceeds the ceiling; the walk must stop there. Which
    // siblings it visits on the way is a traversal-order detail this test
    // deliberately does not pin — only the pruning itself.
    const big = join('/root', 'big')
    const small = join('/root', 'small')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === '/root') return [dir('small'), dir('big')]
      if (d === big) return Array.from({ length: 6 }, (_, i) => file(`f${i}`))
      if (d === small) return [file('only.txt')]
      return []
    })
    expect(await countLocalFilesUpTo('/root', 5)).toBe(6)
    const visited = readdirMock.mock.calls.map((c) => c[0])
    expect(visited).toContain(big)
    expect(visited).not.toContain(small)
  })

  it('walks the whole tree when the count lands exactly on the ceiling', async () => {
    // `count > ceiling` is strictly greater: exactly-ceiling walks to the end.
    readdirMock.mockImplementation(async (d: string) => {
      if (d === '/root') return [dir('a'), file('f0'), file('f1')]
      if (d === join('/root', 'a')) return [file('f2'), file('f3'), file('f4')]
      return []
    })
    expect(await countLocalFilesUpTo('/root', 5)).toBe(5)
    expect(readdirMock).toHaveBeenCalledTimes(2)
  })

  it('counts symlinked/junction directories as files instead of descending them', async () => {
    // Following a junction that points back at an ancestor would walk the
    // cycle forever; not descending also keeps the target's files from being
    // double-counted.
    readdirMock.mockImplementation(async (d: string) => {
      if (d === '/root') return [junction('loop'), file('f0')]
      throw new Error('a junction must never be descended')
    })
    expect(await countLocalFilesUpTo('/root', 5)).toBe(2)
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  it('gives up (undefined) once the directory budget is exhausted', async () => {
    // More empty directories than the budget allows: the file count never
    // grows, so without the budget the walk would readdir every one of them —
    // one round-trip each, minutes on a network share. The tree is flat rather
    // than a chain so the budget is reached against its real production value:
    // a chain deep enough to exhaust it grows the path on every link, which is
    // quadratic string work and takes tens of seconds.
    readdirMock.mockImplementation(async (d: string) =>
      d === '/root'
        ? Array.from({ length: RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES }, (_, i) => dir(`d${i}`))
        : [],
    )
    expect(await countLocalFilesUpTo('/root', 5)).toBeUndefined()
    expect(readdirMock).toHaveBeenCalledTimes(RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES)
  })

  it('returns undefined without reading anything when already aborted', async () => {
    readdirMock.mockImplementation(async () => [file('x')])
    expect(await countLocalFilesUpTo('/root', 5, AbortSignal.abort())).toBeUndefined()
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('returns undefined when the root cannot be read (degrade to a normal scan)', async () => {
    readdirMock.mockImplementation(async () => {
      throw new Error('EPERM')
    })
    expect(await countLocalFilesUpTo('/root', 5)).toBeUndefined()
  })

  it('returns undefined when a subdirectory read fails mid-walk', async () => {
    readdirMock.mockImplementation(async (d: string) => {
      if (d === '/root') return [dir('broken')]
      throw new Error('EIO')
    })
    expect(await countLocalFilesUpTo('/root', 5)).toBeUndefined()
  })
})
