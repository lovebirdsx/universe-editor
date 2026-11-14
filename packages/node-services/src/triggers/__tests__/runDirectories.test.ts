import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { pruneRunDirectories } from '../runDirectories.js'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function createRoot(): Promise<string> {
  const dir = mkTempDir('ue-trigger-runs-')
  cleanup.push(async () => {
    await removeDirWithRetry(dir)
  })
  const runsRoot = join(dir, 'runs')
  await fs.mkdir(runsRoot, { recursive: true })
  return runsRoot
}

/** Directories are ordered by mtime, so set them explicitly. */
async function addRun(root: string, name: string, mtimeMs: number): Promise<void> {
  const dir = join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'report.md'), name, 'utf8')
  await fs.utimes(dir, mtimeMs / 1000, mtimeMs / 1000)
}

describe('pruneRunDirectories', () => {
  it('keeps the newest `keep` directories and reports what it deleted', async () => {
    const root = await createRoot()
    await addRun(root, 'oldest', 1_000)
    await addRun(root, 'middle', 2_000)
    await addRun(root, 'newest', 3_000)

    const { removed } = await pruneRunDirectories(root, { keep: 2 })

    expect(removed).toEqual(['oldest'])
    expect((await fs.readdir(root)).sort()).toEqual(['middle', 'newest'])
  })

  it('never deletes a protected run id, even when it is the oldest', async () => {
    const root = await createRoot()
    await addRun(root, 'oldest', 1_000)
    await addRun(root, 'middle', 2_000)
    await addRun(root, 'newest', 3_000)

    const { removed } = await pruneRunDirectories(root, {
      keep: 1,
      protectedRunIds: new Set(['oldest']),
    })

    // Protected entries do not count toward `keep`: the newest unprotected stays.
    expect(removed).toEqual(['middle'])
    expect((await fs.readdir(root)).sort()).toEqual(['newest', 'oldest'])
  })

  it('is a no-op when the root is missing or within the keep budget', async () => {
    const missing = join(await createRoot(), 'nope')
    expect(await pruneRunDirectories(missing, { keep: 1 })).toEqual({ removed: [] })

    const root = await createRoot()
    await addRun(root, 'only', 1_000)
    expect(await pruneRunDirectories(root, { keep: 4 })).toEqual({ removed: [] })
    expect(await fs.readdir(root)).toEqual(['only'])
  })

  it('ignores files in the runs root', async () => {
    const root = await createRoot()
    await addRun(root, 'run-a', 1_000)
    await addRun(root, 'run-b', 2_000)
    await fs.writeFile(join(root, 'stray.txt'), 'x')

    const { removed } = await pruneRunDirectories(root, { keep: 1 })

    expect(removed).toEqual(['run-a'])
    expect((await fs.readdir(root)).sort()).toEqual(['run-b', 'stray.txt'])
  })
})
