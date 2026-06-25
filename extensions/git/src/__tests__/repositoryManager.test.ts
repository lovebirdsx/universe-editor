import { describe, expect, it, vi } from 'vitest'

// RepositoryManager only touches Repository via `new Repository(root, ...)` and
// `repo.root` / `repo.dispose()`. Stub it so routing can be tested without git.
vi.mock('../repository.js', () => ({
  Repository: class {
    constructor(readonly root: string) {}
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
