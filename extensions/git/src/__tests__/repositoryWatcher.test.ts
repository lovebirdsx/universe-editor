import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepositoryWatcher } from '../repositoryWatcher.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ue-git-watch-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('RepositoryWatcher', () => {
  it('fires a debounced change when a file under the root changes', async () => {
    let count = 0
    const watcher = new RepositoryWatcher(root, () => {
      count++
    })
    watcher.start()
    await writeFile(join(root, 'a.txt'), '1')
    await writeFile(join(root, 'b.txt'), '2')
    // Debounce coalesces the rapid writes into a single fire after 400ms.
    await wait(700)
    watcher.dispose()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('does not fire after dispose', async () => {
    let count = 0
    const watcher = new RepositoryWatcher(root, () => {
      count++
    })
    watcher.start()
    watcher.dispose()
    await writeFile(join(root, 'c.txt'), '3')
    await wait(700)
    expect(count).toBe(0)
  })
})
