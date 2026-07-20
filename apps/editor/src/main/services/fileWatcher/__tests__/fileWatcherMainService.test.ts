/*---------------------------------------------------------------------------------------------
 *  Tests for FileWatcherMainService — verifies @parcel/watcher wiring, ignore
 *  globs, debounce, and create/update/delete classification.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Accumulates every event the service fires until stopped. parcel's native→JS
// delivery latency varies with machine load, so tests poll this buffer (for
// "expect an event") or wait a fixed window (for "expect no event").
function startCollecting(svc: FileWatcherMainService): {
  events: IFileChangeEvent[]
  stop: () => void
} {
  const events: IFileChangeEvent[] = []
  const sub = svc.onDidChangeFiles((batch) => events.push(...batch))
  return { events, stop: () => sub.dispose() }
}

const WAIT = { timeout: 5000, interval: 50 } as const
// The native (parcel) watcher's delivery latency spikes under parallel CI load.
// WAIT.timeout equals vitest's default 5s testTimeout, so a slow batch can trip
// the overall test timeout before vi.waitFor gets to report. Give watcher-backed
// tests headroom beyond WAIT so a real miss surfaces as the waitFor assertion.
const WATCHER_TEST_TIMEOUT = 15000
// Fixed window for "no event should arrive": an ignored change never fires, so
// waiting longer can't make it appear — this stays deterministic under load.
const NO_EVENT_WINDOW_MS = 800

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

  it(
    'emits an event when a file is created',
    async () => {
      await svc.watch(URI.file(root))
      const target = join(root, 'new.txt')
      const c = startCollecting(svc)
      await fs.writeFile(target, 'hello')
      await vi.waitFor(() => {
        svc._flushForTests()
        const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(target))
        expect(matched).toBeDefined()
        // create + write may collapse to create or update depending on platform/timing.
        expect(['added', 'modified']).toContain(matched?.type)
      }, WAIT)
      c.stop()
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'emits a deleted event when a file is removed',
    async () => {
      const target = join(root, 'gone.txt')
      await fs.writeFile(target, 'x')
      await svc.watch(URI.file(root))
      const c = startCollecting(svc)
      await fs.rm(target)
      await vi.waitFor(() => {
        svc._flushForTests()
        const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(target))
        expect(matched?.type).toBe('deleted')
      }, WAIT)
      c.stop()
    },
    WATCHER_TEST_TIMEOUT,
  )

  it('ignores changes inside node_modules', async () => {
    await fs.mkdir(join(root, 'node_modules'), { recursive: true })
    await svc.watch(URI.file(root))
    const c = startCollecting(svc)
    await fs.writeFile(join(root, 'node_modules', 'pkg.json'), '{}')
    await new Promise((r) => setTimeout(r, NO_EVENT_WINDOW_MS))
    svc._flushForTests()
    c.stop()
    const insideNodeModules = c.events.filter((e) =>
      normPath(reviveFsPath(e)).includes(normPath(`${root}${pathSep}node_modules`)),
    )
    expect(insideNodeModules.length).toBe(0)
  })

  it('applies excludes passed to watch()', async () => {
    await fs.mkdir(join(root, 'build'), { recursive: true })
    await svc.watch(URI.file(root), { excludes: ['**/build', '**/build/**'] })
    const c = startCollecting(svc)
    await fs.writeFile(join(root, 'build', 'out.js'), '1')
    await new Promise((r) => setTimeout(r, NO_EVENT_WINDOW_MS))
    svc._flushForTests()
    c.stop()
    const inside = c.events.filter((e) =>
      normPath(reviveFsPath(e)).includes(normPath(`${root}${pathSep}build`)),
    )
    expect(inside.length).toBe(0)
  })

  it(
    'setExcludes re-applies the ignore set on the active watch',
    async () => {
      await svc.watch(URI.file(root))
      // node_modules is no longer ignored once we install an empty exclude set.
      await svc.setExcludes([])
      await fs.mkdir(join(root, 'node_modules'), { recursive: true })
      const c = startCollecting(svc)
      await fs.writeFile(join(root, 'node_modules', 'pkg.json'), '{}')
      await vi.waitFor(() => {
        svc._flushForTests()
        const inside = c.events.filter((e) =>
          normPath(reviveFsPath(e)).includes(normPath(`${root}${pathSep}node_modules`)),
        )
        expect(inside.length).toBeGreaterThan(0)
      }, WAIT)
      c.stop()
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'debounces rapid writes into a small number of batches',
    async () => {
      await svc.watch(URI.file(root))
      const target = join(root, 'rapid.txt')
      const batches: number[] = []
      const sub = svc.onDidChangeFiles((batch) => batches.push(batch.length))
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(target, String(i))
      }
      // Poll for the debounced batch instead of relying on a fixed sleep.
      await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), WAIT)
      // Allow a moment for any trailing batch, then assert writes coalesced.
      await new Promise((r) => setTimeout(r, 100))
      sub.dispose()
      expect(batches.length).toBeLessThanOrEqual(2)
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'emits events for out-of-workspace files registered via watchOutOfWorkspace',
    async () => {
      // Create a separate tmpdir (simulates a path outside the workspace root).
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-out-'))
      const file = join(outRoot, 'external.txt')
      await fs.writeFile(file, 'initial')
      try {
        await svc.watch(URI.file(root)) // workspace root ≠ outRoot
        await svc.watchOutOfWorkspace([URI.file(file)])
        const c = startCollecting(svc)
        await fs.writeFile(file, 'modified')
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched).toBeDefined()
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'does not emit events for workspace files passed to watchOutOfWorkspace',
    async () => {
      // Files under the workspace root should be handled by the parcel watcher,
      // so watchOutOfWorkspace should skip them and not set up extra fs.watch.
      const inWorkspace = join(root, 'inws.txt')
      await fs.writeFile(inWorkspace, 'v1')
      await svc.watch(URI.file(root))
      // watchOutOfWorkspace is a no-op for in-workspace paths — the parcel
      // watcher covers them; calling it should not break anything.
      await svc.watchOutOfWorkspace([URI.file(inWorkspace)])
      // Parcel still fires for workspace-internal changes.
      const c = startCollecting(svc)
      await fs.writeFile(inWorkspace, 'v2')
      await vi.waitFor(() => {
        svc._flushForTests()
        const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(inWorkspace))
        expect(matched).toBeDefined()
      }, WAIT)
      c.stop()
    },
    WATCHER_TEST_TIMEOUT,
  )
})
