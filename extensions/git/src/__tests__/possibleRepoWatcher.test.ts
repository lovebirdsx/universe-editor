import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PossibleRepoWatcher,
  joinCandidate,
  repoCandidateFromPath,
} from '../possibleRepoWatcher.js'

describe('repoCandidateFromPath', () => {
  it('returns the owning directory for a .git entry', () => {
    expect(repoCandidateFromPath('.git')).toBe('')
    expect(repoCandidateFromPath('sub/.git')).toBe('sub')
    expect(repoCandidateFromPath('a/b/.git/config')).toBe('a/b')
    expect(repoCandidateFromPath('sub\\.git\\HEAD')).toBe('sub') // win32 separators
  })

  it('ignores unrelated paths', () => {
    expect(repoCandidateFromPath('src/index.ts')).toBeUndefined()
    expect(repoCandidateFromPath('.gitignore')).toBeUndefined()
    expect(repoCandidateFromPath('foo.git/config')).toBeUndefined()
  })
})

describe('joinCandidate', () => {
  it('joins the workspace root with the relative candidate', () => {
    const root = join('/tmp', 'ws')
    expect(joinCandidate(root, '')).toBe(root)
    expect(joinCandidate(root, 'sub/dir')).toBe(join(root, 'sub', 'dir'))
  })
})

describe('PossibleRepoWatcher', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ue-git-late-watch-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('reports a .git directory created after start (debounced, once)', async () => {
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher(root, (dirs) => batches.push([...dirs]))
    watcher.start()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(root, 'plain.txt'), 'x')
    await wait(900)
    watcher.dispose()
    const flat = batches.flat()
    expect(flat).toContain('')
    expect(flat).not.toContain('plain.txt')
  })

  it('reports a nested repo directory', async () => {
    const sub = join(root, 'sub')
    await mkdir(sub)
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher(root, (dirs) => batches.push([...dirs]))
    watcher.start()
    // Let the watcher settle so the mkdir of `sub` itself isn't in flight.
    await wait(200)
    await mkdir(join(sub, '.git'))
    await wait(900)
    watcher.dispose()
    expect(batches.flat()).toContain('sub')
  })

  it('does not fire after dispose', async () => {
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher(root, (dirs) => batches.push([...dirs]))
    watcher.start()
    watcher.dispose()
    await mkdir(join(root, '.git'))
    await wait(900)
    expect(batches).toHaveLength(0)
  })
})
