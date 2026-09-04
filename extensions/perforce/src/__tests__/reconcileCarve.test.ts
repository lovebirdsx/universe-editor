/**
 * Unit tests for `reconcileCarve` — turning `perforce.reconcile.excludeFolders`
 * into filespecs that cover everything except the excluded subtrees. Locks in:
 *  1. Every visited level emits `<dir>/*` (so `p4 reconcile -d` still sees
 *     locally deleted files, which readdir cannot report).
 *  2. Clean subtrees emit recursive `<sub>/...`, subtrees containing excluded
 *     descendants are re-carved, excluded subtrees emit nothing AND are never
 *     readdir'ed.
 *  3. Symlinked/junction directories emit `<link>/...` (p4 decides whether to
 *     follow) but are never descended.
 *  4. Any readdir failure / abort / directory-budget exhaustion returns
 *     undefined — never a widened spec.
 *  5. `carveReconcileTargets` drops excluded targets, carves mixed ones,
 *     records unreadable directories without losing the rest, and degrades to
 *     plain recursive specs when there is nothing to exclude.
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

// The budget-exhaustion test walks a chain one node per budget slot, and every
// level emits a `<dir>/*` spec whose length grows with depth — against the
// production budget (10_000) that is O(MAX²) string work and takes tens of
// seconds, blowing the 30s test timeout on CI. The logic under test is
// "exhausted budget → undefined", not the constant's value (that value's
// realism is covered flat by `countLocalFilesUpTo`'s budget test), so shrink
// it here. vi.mock is hoisted above the dynamic imports below.
vi.mock('../reconcileScanBudget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reconcileScanBudget.js')>()
  return { ...actual, RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES: 50 }
})

const { carveReconcileFilespecs, carveReconcileTargets } = await import('../reconcileCarve.js')
const { RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES } = await import('../reconcileScanBudget.js')

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
 *  also a reparse point — the carve must spec it, never follow it. */
function junction(name: string): {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return { name, isDirectory: () => true, isSymbolicLink: () => true }
}

const ROOT = '/root'

describe('carveReconcileFilespecs', () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it('emits level /*, recursive /... for clean subtrees, and re-carves mixed ones', async () => {
    const excluded = join(ROOT, 'excluded')
    const exsub = join(ROOT, 'mixed', 'exsub')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) {
        return [file('a.txt'), dir('clean'), dir('excluded'), dir('mixed'), junction('link')]
      }
      if (d === join(ROOT, 'mixed')) return [dir('exsub'), dir('sibling')]
      throw new Error('unexpected readdir')
    })
    const specs = await carveReconcileFilespecs(ROOT, [excluded, exsub])
    expect(specs).toEqual([
      `${ROOT}/*`,
      `${join(ROOT, 'clean')}/...`,
      `${join(ROOT, 'link')}/...`,
      `${join(ROOT, 'mixed')}/*`,
      `${join(ROOT, 'mixed', 'sibling')}/...`,
    ])
  })

  it('never readdirs excluded subtrees or symlinked directories', async () => {
    const excluded = join(ROOT, 'excluded')
    const exsub = join(ROOT, 'mixed', 'exsub')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [dir('clean'), dir('excluded'), dir('mixed'), junction('link')]
      if (d === join(ROOT, 'mixed')) return [dir('exsub'), dir('sibling')]
      throw new Error('unexpected readdir')
    })
    await carveReconcileFilespecs(ROOT, [excluded, exsub])
    const visited = readdirMock.mock.calls.map((c) => c[0])
    expect(visited).toEqual([ROOT, join(ROOT, 'mixed')])
  })

  it('drops an excluded junction and one whose subtree holds an exclude', async () => {
    // Exclusion beats coverage for link subtrees: we refuse to walk them (cycle
    // guard), so a `/...` spec is the only alternative and it would widen back
    // into excluded territory.
    const linkExcluded = join(ROOT, 'linkExcluded')
    const under = join(ROOT, 'linkNested', 'inner')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [junction('linkExcluded'), junction('linkNested'), junction('linkOk')]
      throw new Error('a junction must never be read')
    })
    expect(await carveReconcileFilespecs(ROOT, [linkExcluded, under])).toEqual([
      `${ROOT}/*`,
      `${join(ROOT, 'linkOk')}/...`,
    ])
  })

  it('emits only the level spec when every child is excluded', async () => {
    const excluded = join(ROOT, 'excluded')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [dir('excluded')]
      throw new Error('an excluded subtree must never be read')
    })
    expect(await carveReconcileFilespecs(ROOT, [excluded])).toEqual([`${ROOT}/*`])
  })

  it('escapes filespec metacharacters in emitted directory specs', async () => {
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [dir('we@ird#dir%1*2')]
      return []
    })
    expect(await carveReconcileFilespecs(ROOT, [])).toEqual([
      `${ROOT}/*`,
      `${join(ROOT, 'we%40ird%23dir%251%2A2')}/...`,
    ])
  })

  it('returns undefined when the root cannot be read', async () => {
    readdirMock.mockImplementation(async () => {
      throw new Error('EPERM')
    })
    expect(await carveReconcileFilespecs(ROOT, [])).toBeUndefined()
  })

  it('returns undefined when a mixed subtree read fails mid-walk', async () => {
    const exsub = join(ROOT, 'broken', 'x')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === ROOT) return [dir('broken')]
      throw new Error('EIO')
    })
    expect(await carveReconcileFilespecs(ROOT, [exsub])).toBeUndefined()
  })

  it('returns undefined without reading anything when already aborted', async () => {
    readdirMock.mockImplementation(async () => [file('x')])
    expect(await carveReconcileFilespecs(ROOT, [], AbortSignal.abort())).toBeUndefined()
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('returns undefined once the directory budget is exhausted', async () => {
    // A chain deeper than the budget with a single exclude at its tail: every
    // node on the chain contains the exclude, so every node is pushed and
    // visited until the budget runs out. The budget is mocked down to 50 (see
    // the top of this file) — against the production value the per-level
    // `<dir>/*` spec strings grow with depth and the walk is O(MAX²) string
    // work, tens of seconds on CI.
    const link = Array.from({ length: RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES + 1 }, () => 'd')
    const excluded = join(ROOT, ...link, 'x')
    readdirMock.mockImplementation(async () => [dir('d')])
    expect(await carveReconcileFilespecs(ROOT, [excluded])).toBeUndefined()
    expect(readdirMock).toHaveBeenCalledTimes(RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES)
  })
})

describe('carveReconcileTargets', () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it('drops excluded files and keeps the rest', async () => {
    const excluded = join(ROOT, 'ex')
    const result = await carveReconcileTargets(
      [
        { path: join(excluded, 'a.txt'), isDirectory: false },
        { path: join(ROOT, 'keep.txt'), isDirectory: false },
      ],
      [excluded],
    )
    expect(result).toEqual({ specs: [join(ROOT, 'keep.txt')], unreadableDirs: [] })
  })

  it('handles the three directory states: excluded, clean, and mixed', async () => {
    const ex = join(ROOT, 'ex')
    const exsub = join(ROOT, 'mixed', 'exsub')
    readdirMock.mockImplementation(async (d: string) => {
      if (d === join(ROOT, 'mixed')) return [dir('exsub'), dir('sibling')]
      throw new Error('unexpected readdir')
    })
    const result = await carveReconcileTargets(
      [
        { path: ex, isDirectory: true },
        { path: join(ROOT, 'clean'), isDirectory: true },
        { path: join(ROOT, 'mixed'), isDirectory: true },
      ],
      [ex, exsub],
    )
    expect(result.specs).toEqual([
      `${join(ROOT, 'clean')}/...`,
      `${join(ROOT, 'mixed')}/*`,
      `${join(ROOT, 'mixed', 'sibling')}/...`,
    ])
    expect(result.unreadableDirs).toEqual([])
  })

  it('records unreadable directories and still produces the remaining specs', async () => {
    const bad = join(ROOT, 'bad')
    readdirMock.mockImplementation(async () => {
      throw new Error('EACCES')
    })
    const result = await carveReconcileTargets(
      [
        { path: bad, isDirectory: true },
        { path: join(ROOT, 'ok.txt'), isDirectory: false },
        { path: join(ROOT, 'clean'), isDirectory: true },
      ],
      [join(bad, 'x')],
    )
    expect(result).toEqual({
      specs: [join(ROOT, 'ok.txt'), `${join(ROOT, 'clean')}/...`],
      unreadableDirs: [bad],
    })
  })

  it('degrades to plain recursive specs with empty excludeDirs, without any readdir', async () => {
    readdirMock.mockImplementation(async () => {
      throw new Error('nothing to exclude, nothing to read')
    })
    const result = await carveReconcileTargets(
      [
        { path: join(ROOT, 'dir'), isDirectory: true },
        { path: join(ROOT, 'a.txt'), isDirectory: false },
      ],
      [],
    )
    expect(result).toEqual({
      specs: [`${join(ROOT, 'dir')}/...`, join(ROOT, 'a.txt')],
      unreadableDirs: [],
    })
    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('skips empty paths', async () => {
    const result = await carveReconcileTargets([{ path: '', isDirectory: true }], [])
    expect(result).toEqual({ specs: [], unreadableDirs: [] })
  })
})
