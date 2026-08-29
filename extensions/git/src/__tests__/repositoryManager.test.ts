import { describe, expect, it, vi } from 'vitest'
import type { RepositoryOptions } from '../repositoryTypes.js'

// RepositoryManager only touches Repository via `new Repository(root, ...)` and
// `repo.root` / `repo.refresh()` / `repo.dispose()`. Stub it so routing can be
// tested without git.
vi.mock('../repository.js', () => ({
  Repository: class {
    readonly refresh = vi.fn(async () => {})
    constructor(
      readonly root: string,
      readonly log?: (msg: string) => void,
      readonly opts: RepositoryOptions = {},
    ) {}
    dispose(): void {}
  },
}))

import { RepositoryManager } from '../repositoryManager.js'

const MAIN = '/repo'
const SUB = '/repo/sub'

function makeManager(): RepositoryManager {
  const mgr = new RepositoryManager(MAIN)
  mgr.add(MAIN, {})
  mgr.add(SUB, {})
  return mgr
}

describe('RepositoryManager routing', () => {
  it('resolves an explicit rootUri', () => {
    const mgr = makeManager()
    expect(mgr.resolveRepo({ rootUri: SUB })?.root).toBe(SUB)
  })

  it('resolves a resourceUri to the longest containing repo', () => {
    const mgr = makeManager()
    expect(mgr.resolveRepo({ resourceUri: `${SUB}/file.ts` })?.root).toBe(SUB)
    expect(mgr.resolveRepo({ resourceUri: `${MAIN}/file.ts` })?.root).toBe(MAIN)
  })

  it('falls back to the main repo when nothing is active', () => {
    const mgr = makeManager()
    expect(mgr.resolveRepo(undefined)?.root).toBe(MAIN)
    expect(mgr.active?.root).toBe(MAIN)
  })

  it('argument-less commands follow the active repo once set', () => {
    const mgr = makeManager()
    mgr.setActive(SUB)
    expect(mgr.active?.root).toBe(SUB)
    expect(mgr.resolveRepo(undefined)?.root).toBe(SUB)
  })

  it('ignores setActive for an unknown root', () => {
    const mgr = makeManager()
    mgr.setActive('/not/a/repo')
    expect(mgr.active?.root).toBe(MAIN)
  })

  it('an explicit arg still overrides the active repo', () => {
    const mgr = makeManager()
    mgr.setActive(SUB)
    expect(mgr.resolveRepo({ rootUri: MAIN })?.root).toBe(MAIN)
  })
})

describe('RepositoryManager late additions', () => {
  it('fires onDidAdd only for genuinely new repos', () => {
    const mgr = new RepositoryManager(MAIN)
    const added: string[] = []
    mgr.onDidAdd((repo) => added.push(repo.root))
    mgr.add(MAIN, {})
    mgr.add(MAIN, {}) // duplicate → no event
    mgr.add(SUB, {})
    expect(added).toEqual([MAIN, SUB])
  })

  it('has() reports known roots', () => {
    const mgr = makeManager()
    expect(mgr.has(MAIN)).toBe(true)
    expect(mgr.has('/elsewhere')).toBe(false)
  })

  it('setMainRoot promotes an added repo to main and active', () => {
    const mgr = new RepositoryManager('/initial')
    mgr.add('/initial', {})
    const late = mgr.add(MAIN, {})
    mgr.setMainRoot(MAIN)
    expect(mgr.mainRoot).toBe(MAIN)
    expect(mgr.main?.root).toBe(MAIN)
    expect(mgr.active?.root).toBe(MAIN)
    expect(late.root).toBe(MAIN)
  })

  it('setMainRoot ignores unknown roots', () => {
    const mgr = makeManager()
    mgr.setMainRoot('/not/a/repo')
    expect(mgr.mainRoot).toBe(MAIN)
  })
})

describe('RepositoryManager submodule tracking', () => {
  const NESTED = '/repo/sub/nested'
  // A linked worktree lives beside the repo, not under it, so the prefix match
  // must not pick it up.
  const WORKTREE = '/repo.worktrees/feature'
  const OTHER = '/elsewhere'

  function makeFullManager(): RepositoryManager {
    const mgr = new RepositoryManager(MAIN)
    for (const root of [MAIN, SUB, NESTED, WORKTREE, OTHER]) mgr.add(root, {})
    return mgr
  }

  it('lists repos nested under a root, excluding itself and siblings', () => {
    const mgr = makeFullManager()
    expect(mgr.submodulesOf(MAIN).map((r) => r.root)).toEqual([SUB, NESTED])
  })

  it('lists only deeper repos for a submodule root', () => {
    const mgr = makeFullManager()
    expect(mgr.submodulesOf(SUB).map((r) => r.root)).toEqual([NESTED])
    expect(mgr.submodulesOf(NESTED)).toEqual([])
  })

  it('refreshes nested repos when a repo reports its submodules moved', async () => {
    const mgr = makeFullManager()
    const main = mgr.resolveRepo({ rootUri: MAIN })
    const sub = mgr.resolveRepo({ rootUri: SUB })
    const unrelated = mgr.resolveRepo({ rootUri: OTHER })

    ;(main as unknown as { opts: RepositoryOptions }).opts.onSubmodulesUpdated?.()
    await Promise.resolve()

    expect((sub as unknown as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalled()
    expect(
      (unrelated as unknown as { refresh: ReturnType<typeof vi.fn> }).refresh,
    ).not.toHaveBeenCalled()
  })
})
