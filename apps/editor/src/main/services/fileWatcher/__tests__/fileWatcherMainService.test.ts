/*---------------------------------------------------------------------------------------------
 *  Tests for FileWatcherMainService — verifies the client → protocol → host →
 *  @parcel/watcher chain (via the in-memory transport), ignore globs, debounce,
 *  create/update/delete classification, and crash-restart replay.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep as pathSep } from 'node:path'
import { platform } from 'node:process'
import { Emitter, URI, type IFileChangeEvent } from '@universe-editor/platform'
import { FileWatcherMainService } from '../fileWatcherMainService.js'
import { WatcherProcessClient } from '../watcherProcessClient.js'
import {
  createInMemoryWatcherTransport,
  type InMemoryWatcherTransport,
} from '../testing/inMemoryWatcherTransport.js'

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

// The native (parcel) watcher's delivery latency spikes under parallel CI load
// (vitest runs many main-project files concurrently; the native→JS callback can
// be queued for seconds). Keep headroom below WATCHER_TEST_TIMEOUT so a real
// miss surfaces as the waitFor assertion instead of the overall test timeout.
const WAIT = { timeout: 10000, interval: 50 } as const
const WATCHER_TEST_TIMEOUT = 15000
// Fixed window for "no event should arrive": an ignored change never fires, so
// waiting longer can't make it appear — this stays deterministic under load.
const NO_EVENT_WINDOW_MS = 800

describe('FileWatcherMainService', () => {
  let root: string
  let transports: InMemoryWatcherTransport[]
  let client: WatcherProcessClient
  let svc: FileWatcherMainService

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'universe-editor-fw-'))
    transports = []
    client = new WatcherProcessClient(() => {
      const t = createInMemoryWatcherTransport()
      transports.push(t)
      return t
    })
    svc = new FileWatcherMainService(client)
  })

  afterEach(async () => {
    // Await the real parcel unsubscribe before deleting the watched tree.
    await svc.unwatch()
    svc.dispose()
    client.dispose()
    await Promise.allSettled(transports.map((t) => t.host.dispose()))
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
      // Re-subscribes are coalesced through a quiet window before reaching
      // native, so wait it out for the write below to be observed.
      await svc.setExcludes([])
      await new Promise((r) => setTimeout(r, 1200))
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

  // fs.watch recursive exists only on win32/darwin; on linux the folder watch
  // falls back to the directory entry itself, so nested files stay invisible.
  it.skipIf(platform === 'linux')(
    'emits events for files nested under an out-of-workspace folder watch',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const nested = join(outRoot, 'deep', 'deeper')
      await fs.mkdir(nested, { recursive: true })
      const file = join(nested, 'watched.log')
      await fs.writeFile(file, 'initial')
      try {
        await svc.watch(URI.file(root)) // workspace root ≠ outRoot
        await svc.watchOutOfWorkspaceFolders([URI.file(outRoot)])
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

  it('watchOutOfWorkspaceFolders skips folders under the workspace root', async () => {
    await svc.watch(URI.file(root))
    // In-workspace folder: the parcel watch already covers it, so the call
    // must not arm a redundant fs.watch (asserted by the map staying empty).
    await svc.watchOutOfWorkspaceFolders([URI.file(join(root, 'sub'))])
    expect(svc._extraFolderWatcherCount).toBe(0)
  })

  it('watchOutOfWorkspaceFolders drops folders nested under an already-watched folder', async () => {
    const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
    try {
      await svc.watchOutOfWorkspaceFolders([URI.file(outRoot), URI.file(join(outRoot, 'child'))])
      expect(svc._extraFolderWatcherCount).toBe(1)
    } finally {
      await fs.rm(outRoot, { recursive: true, force: true })
    }
  })

  it('watchOutOfWorkspaceFolders([]) clears armed folder watches', async () => {
    const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
    try {
      await svc.watchOutOfWorkspaceFolders([URI.file(outRoot)])
      expect(svc._extraFolderWatcherCount).toBe(1)
      await svc.watchOutOfWorkspaceFolders([])
      expect(svc._extraFolderWatcherCount).toBe(0)
    } finally {
      await fs.rm(outRoot, { recursive: true, force: true })
    }
  })

  it(
    'a folder created after the watch armed still gets watched (parent placeholder)',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const missing = join(outRoot, 'not-yet')
      try {
        await svc.watchOutOfWorkspaceFolders([URI.file(missing)])
        // Placeholder on the parent until the folder appears.
        expect(svc._extraFolderWatcherCount).toBe(1)
        await fs.mkdir(missing, { recursive: true })
        const file = join(missing, 'created-later.log')
        const c = startCollecting(svc)
        await vi.waitFor(async () => {
          await fs.writeFile(file, String(Date.now()))
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
    'survives a watcher host crash: restarts, replays the watch, keeps delivering events',
    async () => {
      await svc.watch(URI.file(root))
      expect(transports.length).toBe(1)

      let restarted = false
      const sub = svc.onDidRestart(() => {
        restarted = true
      })
      transports[0]!.simulateCrash()

      await vi.waitFor(() => expect(restarted).toBe(true), WAIT)
      expect(transports.length).toBe(2)

      // The replayed subscription on the fresh host still delivers events.
      const target = join(root, 'after-crash.txt')
      const c = startCollecting(svc)
      await fs.writeFile(target, 'x')
      await vi.waitFor(() => {
        svc._flushForTests()
        const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(target))
        expect(matched).toBeDefined()
      }, WAIT)
      c.stop()
      sub.dispose()
    },
    WATCHER_TEST_TIMEOUT,
  )
})

// Re-subscribe coalescing — the guard against the win32 parcel backend crashing
// on fast unsubscribe→subscribe repeats (observed during startup exclude
// hydration). A stub host + fake timers keep these deterministic and fast; the
// real native chain is covered by the integration tests above.
describe('FileWatcherMainService re-subscribe coalescing', () => {
  function createStubHost() {
    return {
      allocateId: () => 1,
      watch: vi.fn(async (_id: number, _dir: string, _ignore: readonly string[]) => {}),
      unwatch: vi.fn(async (_id: number) => {}),
      onFileEvents: new Emitter<never>().event,
      onWatchError: new Emitter<never>().event,
      onDidRestart: new Emitter<void>().event,
    }
  }

  let host: ReturnType<typeof createStubHost>
  let svc: FileWatcherMainService

  beforeEach(() => {
    vi.useFakeTimers()
    host = createStubHost()
    svc = new FileWatcherMainService(host as unknown as WatcherProcessClient)
  })

  afterEach(() => {
    svc.dispose()
    vi.useRealTimers()
  })

  const root = URI.file('/w/root')
  const otherRoot = URI.file('/w/other')

  it('arms the first watch immediately', async () => {
    await svc.watch(root)
    expect(host.watch).toHaveBeenCalledTimes(1)
  })

  it('dedupes a same-state watch against the live subscription', async () => {
    await svc.watch(root, { excludes: ['**/a/**'] })
    await svc.watch(root, { excludes: ['**/a/**'] })
    expect(host.watch).toHaveBeenCalledTimes(1)
  })

  it('coalesces an exclude storm into one re-subscribe with the latest globs', async () => {
    await svc.watch(root, { excludes: ['**/a/**'] })
    await svc.setExcludes(['**/b/**'])
    await svc.setExcludes(['**/c/**'])
    await svc.setExcludes(['**/d/**'])
    expect(host.watch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(host.watch.mock.calls[1]?.[2]).toEqual(['**/d', '**/d/**'])
  })

  it('slides the quiet window on each change', async () => {
    await svc.watch(root)
    await svc.setExcludes(['**/b/**'])
    await vi.advanceTimersByTimeAsync(300)
    await svc.setExcludes(['**/c/**']) // slides the flush to t=800
    await vi.advanceTimersByTimeAsync(300)
    expect(host.watch).toHaveBeenCalledTimes(1) // t=600: would have flushed without sliding
    await vi.advanceTimersByTimeAsync(200)
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(host.watch.mock.calls[1]?.[2]).toEqual(['**/c', '**/c/**'])
  })

  it('forces the flush at the max wait even while changes keep sliding the window', async () => {
    await svc.watch(root)
    await svc.setExcludes(['**/b/**']) // quiet@500, max@2000
    for (const glob of ['**/c/**', '**/d/**', '**/e/**', '**/f/**']) {
      await vi.advanceTimersByTimeAsync(400)
      await svc.setExcludes([glob])
    }
    // t=1600: quiet window keeps sliding (next flush would be t=2100)…
    expect(host.watch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400) // t=2000: max wait hits
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(host.watch.mock.calls[1]?.[2]).toEqual(['**/f', '**/f/**'])
  })

  it('resolves a merged watch() once the coalesced subscribe lands', async () => {
    await svc.watch(root, { excludes: ['**/a/**'] })
    let landed = false
    const merged = svc.watch(root, { excludes: ['**/b/**'] }).then(() => {
      landed = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(landed).toBe(false)
    expect(host.watch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await merged
    expect(landed).toBe(true)
    expect(host.watch).toHaveBeenCalledTimes(2)
  })

  it('supersedes a pending target when a different root is watched', async () => {
    await svc.watch(root)
    let supersededLanded = false
    const superseded = svc.watch(root, { excludes: ['**/b/**'] }).then(() => {
      supersededLanded = true
    })
    const takeover = svc.watch(otherRoot, { excludes: ['**/c/**'] })
    await vi.advanceTimersByTimeAsync(500)
    await superseded
    await takeover
    expect(supersededLanded).toBe(true)
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(host.watch.mock.calls[1]?.[1]).toBe(otherRoot.fsPath)
  })

  it('cancels a pending re-subscribe on unwatch', async () => {
    await svc.watch(root)
    await svc.setExcludes(['**/b/**'])
    await svc.unwatch()
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.watch).toHaveBeenCalledTimes(1)
    expect(host.unwatch).toHaveBeenCalledTimes(1)
  })

  it('re-arms immediately after unwatch (no stale subscription to race)', async () => {
    await svc.watch(root)
    await svc.setExcludes(['**/b/**'])
    await svc.unwatch()
    await svc.watch(otherRoot)
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(host.watch.mock.calls[1]?.[1]).toBe(otherRoot.fsPath)
  })
})
