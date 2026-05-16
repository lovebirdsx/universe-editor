/*---------------------------------------------------------------------------------------------
 *  Tests for FileWatcherMainService — verifies recursive fs.watch wiring,
 *  ignore prefixes, debounce, and add/modify/delete classification.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep as pathSep } from 'node:path'
import { URI, type IFileChangeEvent } from '@universe-editor/platform'
import { FileWatcherMainService } from '../fileWatcherMainService.js'

function reviveFsPath(c: {
  readonly resource: import('@universe-editor/platform').UriComponents
}): string {
  const u = URI.revive(c.resource)
  if (!u) throw new Error('expected resource')
  return u.fsPath
}

function normPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/')
}

async function waitForEvents(
  svc: FileWatcherMainService,
  timeoutMs = 500,
): Promise<readonly IFileChangeEvent[]> {
  return new Promise((resolve) => {
    let collected: readonly IFileChangeEvent[] = []
    const sub = svc.onDidChangeFiles((batch) => {
      collected = batch
    })
    setTimeout(() => {
      svc._flushForTests()
      sub.dispose()
      resolve(collected)
    }, timeoutMs)
  })
}

describe('FileWatcherMainService', () => {
  let root: string
  let svc: FileWatcherMainService

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'universe-editor-fw-'))
    svc = new FileWatcherMainService()
  })

  afterEach(async () => {
    svc.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('emits a modified event when a file is created', async () => {
    await svc.watch(URI.file(root).toJSON())
    const target = join(root, 'new.txt')
    await fs.writeFile(target, 'hello')
    const events = await waitForEvents(svc)
    const matched = events.find((e) => normPath(reviveFsPath(e)) === normPath(target))
    expect(matched).toBeDefined()
    expect(matched?.type).toBe('modified')
  })

  it('emits a deleted event when a file is removed', async () => {
    const target = join(root, 'gone.txt')
    await fs.writeFile(target, 'x')
    await svc.watch(URI.file(root).toJSON())
    await fs.rm(target)
    const events = await waitForEvents(svc)
    const matched = events.find((e) => normPath(reviveFsPath(e)) === normPath(target))
    expect(matched).toBeDefined()
    expect(matched?.type).toBe('deleted')
  })

  it('ignores changes inside node_modules', async () => {
    await fs.mkdir(join(root, 'node_modules'), { recursive: true })
    await svc.watch(URI.file(root).toJSON())
    await fs.writeFile(join(root, 'node_modules', 'pkg.json'), '{}')
    const events = await waitForEvents(svc)
    const insideNodeModules = events.filter((e) =>
      normPath(reviveFsPath(e)).includes(normPath(`${root}${pathSep}node_modules`)),
    )
    expect(insideNodeModules.length).toBe(0)
  })

  it('debounces rapid writes into a small number of batches', async () => {
    await svc.watch(URI.file(root).toJSON())
    const target = join(root, 'rapid.txt')
    const batches: number[] = []
    const sub = svc.onDidChangeFiles((batch) => batches.push(batch.length))
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(target, String(i))
    }
    await new Promise((r) => setTimeout(r, 200))
    sub.dispose()
    // 5 rapid writes collapse into at most 2 debounced batches.
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.length).toBeLessThanOrEqual(2)
  })
})
