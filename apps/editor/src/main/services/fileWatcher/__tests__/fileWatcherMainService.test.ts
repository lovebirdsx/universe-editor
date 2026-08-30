/*---------------------------------------------------------------------------------------------
 *  Tests for FileWatcherMainService — verifies the client → protocol → host →
 *  @parcel/watcher chain (via the in-memory transport), ignore globs, debounce,
 *  create/update/delete classification, and crash-restart replay.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep as pathSep } from 'node:path'
import { Emitter, URI, type IFileChangeEvent } from '@universe-editor/platform'
import { FileWatcherMainService } from '../fileWatcherMainService.js'
import { WatcherProcessClient } from '@universe-editor/node-services'
import {
  createInMemoryWatcherTransport,
  type InMemoryWatcherTransport,
} from '@universe-editor/node-services'

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

  it('ignores changes inside .vs', async () => {
    await fs.mkdir(join(root, '.vs'), { recursive: true })
    await svc.watch(URI.file(root))
    const c = startCollecting(svc)
    await fs.writeFile(join(root, '.vs', 'index.vsidx'), '1')
    await new Promise((r) => setTimeout(r, NO_EVENT_WINDOW_MS))
    svc._flushForTests()
    c.stop()
    const insideVs = c.events.filter((e) =>
      normPath(reviveFsPath(e)).includes(normPath(`${root}${pathSep}.vs`)),
    )
    expect(insideVs.length).toBe(0)
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

  it(
    'emits events for files nested under an out-of-workspace folder watch',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const nested = join(outRoot, 'deep', 'deeper')
      await fs.mkdir(nested, { recursive: true })
      const file = join(nested, 'watched.log')
      await fs.writeFile(file, 'initial')
      try {
        await svc.watch(URI.file(root)) // workspace root ≠ outRoot
        await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
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

  it('addOutOfWorkspaceFolder skips folders under the workspace root', async () => {
    await svc.watch(URI.file(root))
    // In-workspace folder: the parcel watch already covers it, so the call
    // must not arm a redundant fs.watch (asserted by the map staying empty).
    await svc.addOutOfWorkspaceFolder(URI.file(join(root, 'sub')))
    expect(svc._extraFolderWatcherCount).toBe(0)
  })

  it('a folder nested under an already-watched folder collapses into the parent watch', async () => {
    const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
    try {
      await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
      await svc.addOutOfWorkspaceFolder(URI.file(join(outRoot, 'child')))
      expect(svc._extraFolderWatcherCount).toBe(1)
    } finally {
      await fs.rm(outRoot, { recursive: true, force: true })
    }
  })

  it('removing the parent re-arms a still-declared nested child', async () => {
    const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
    try {
      await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
      await svc.addOutOfWorkspaceFolder(URI.file(join(outRoot, 'child')))
      expect(svc._extraFolderWatcherCount).toBe(1)
      await svc.removeOutOfWorkspaceFolder(URI.file(outRoot))
      expect(svc._extraFolderWatcherCount).toBe(1)
      await svc.removeOutOfWorkspaceFolder(URI.file(join(outRoot, 'child')))
      expect(svc._extraFolderWatcherCount).toBe(0)
    } finally {
      await fs.rm(outRoot, { recursive: true, force: true })
    }
  })

  it('clearOutOfWorkspaceFolders clears armed folder watches', async () => {
    const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
    try {
      await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
      expect(svc._extraFolderWatcherCount).toBe(1)
      await svc.clearOutOfWorkspaceFolders()
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
        await svc.addOutOfWorkspaceFolder(URI.file(missing))
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
    'classifies a created entry under an out-of-workspace folder watch as added',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      try {
        await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
        // mkdir emits a bare rename event — no content write follows to
        // coalesce 'added' into 'modified' within the debounce window.
        const created = join(outRoot, 'new-dir')
        const c = startCollecting(svc)
        await fs.mkdir(created)
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(created))
          expect(matched?.type).toBe('added')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'classifies a removed file under an out-of-workspace folder watch as deleted',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const file = join(outRoot, 'doomed.txt')
      await fs.writeFile(file, 'x')
      try {
        await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
        const c = startCollecting(svc)
        await fs.rm(file)
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched?.type).toBe('deleted')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'keeps in-place changes under an out-of-workspace folder watch as modified',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const file = join(outRoot, 'stable.txt')
      await fs.writeFile(file, 'v1')
      try {
        await svc.addOutOfWorkspaceFolder(URI.file(outRoot))
        const c = startCollecting(svc)
        await fs.writeFile(file, 'v2')
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched?.type).toBe('modified')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'emits a deleted event when an out-of-workspace watched file is removed',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-out-'))
      const file = join(outRoot, 'external.txt')
      await fs.writeFile(file, 'initial')
      try {
        await svc.watchOutOfWorkspace([URI.file(file)])
        const c = startCollecting(svc)
        await fs.rm(file)
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched?.type).toBe('deleted')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'emits an added event when an out-of-workspace watched file appears after arming',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-out-'))
      const staging = await fs.mkdtemp(join(tmpdir(), 'universe-editor-stage-'))
      const file = join(outRoot, 'later.txt')
      try {
        // A rename-in delivers a bare rename event — unlike writeFile it is
        // not followed by a change event that would coalesce 'added' into
        // 'modified' within the debounce window.
        await fs.writeFile(join(staging, 'staged.txt'), 'x')
        await svc.watchOutOfWorkspace([URI.file(file)])
        const c = startCollecting(svc)
        await fs.rename(join(staging, 'staged.txt'), file)
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.find((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched?.type).toBe('added')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
        await fs.rm(staging, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'keeps an atomic-save (rename over) of an out-of-workspace watched file as modified',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-out-'))
      const file = join(outRoot, 'external.txt')
      const temp = join(outRoot, 'external.txt.tmp')
      await fs.writeFile(file, 'initial')
      try {
        await svc.watchOutOfWorkspace([URI.file(file)])
        const c = startCollecting(svc)
        await fs.writeFile(temp, 'saved')
        await fs.rename(temp, file)
        await vi.waitFor(() => {
          svc._flushForTests()
          const matched = c.events.filter((e) => normPath(reviveFsPath(e)) === normPath(file))
          expect(matched.length).toBeGreaterThan(0)
          for (const e of matched) expect(e.type).toBe('modified')
        }, WAIT)
        c.stop()
      } finally {
        await fs.rm(outRoot, { recursive: true, force: true })
      }
    },
    WATCHER_TEST_TIMEOUT,
  )

  it(
    'keeps the parent placeholder through unrelated churn until the watched folder appears',
    async () => {
      const outRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outdir-'))
      const missing = join(outRoot, 'not-yet')
      try {
        await svc.addOutOfWorkspaceFolder(URI.file(missing))
        expect(svc._extraFolderWatcherCount).toBe(1)
        await fs.writeFile(join(outRoot, 'noise.txt'), 'n')
        // Give the parent watcher a window to deliver the unrelated event: it
        // must not retire the placeholder.
        await new Promise((r) => setTimeout(r, 300))
        expect(svc._extraFolderWatcherCount).toBe(1)
        await fs.mkdir(missing)
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

// Focus mode: `scopes` replaces the single recursive root with N subtree
// subscriptions, coordinated through the SAME quiet window as the single-root
// case — a per-target window would let concurrent changes land a mix of old and
// new targets.
describe('FileWatcherMainService focus scopes', () => {
  let nextId: number
  function createStubHost() {
    nextId = 1
    return {
      allocateId: () => nextId++,
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
  const client = URI.file('/w/root/Client')
  const server = URI.file('/w/root/Server')

  /** Sorted (dir, id) pairs of the watch calls made since `from`. */
  function watchTargets(from = 0): string[] {
    return host.watch.mock.calls
      .slice(from)
      .map((c) => String(c[1]))
      .sort()
  }

  it('subscribes one target per scope instead of the root', async () => {
    await svc.watch(root, { scopes: [client, server] })
    expect(host.watch).toHaveBeenCalledTimes(2)
    expect(watchTargets()).toEqual([client.fsPath, server.fsPath].sort())
    expect(host.watch.mock.calls.some((c) => c[1] === root.fsPath)).toBe(false)
  })

  it('gives the first target the stable primary id so crash replay is unchanged', async () => {
    await svc.watch(root, { scopes: [client, server] })
    const ids = host.watch.mock.calls.map((c) => c[0])
    expect(ids).toContain(1) // allocated in the constructor
    expect(new Set(ids).size).toBe(2)
  })

  it('collapses a scope nested inside another into the shallower one', async () => {
    await svc.watch(root, { scopes: [client, URI.file('/w/root/Client/Sub')] })
    expect(host.watch).toHaveBeenCalledTimes(1)
    expect(host.watch.mock.calls[0]?.[1]).toBe(client.fsPath)
  })

  it('falls back to the root when a scope IS the root', async () => {
    await svc.watch(root, { scopes: [root] })
    expect(host.watch).toHaveBeenCalledTimes(1)
    expect(host.watch.mock.calls[0]?.[1]).toBe(root.fsPath)
  })

  it('drops scopes outside the workspace rather than widening the watch', async () => {
    await svc.watch(root, { scopes: [client, URI.file('/elsewhere')] })
    expect(watchTargets()).toEqual([client.fsPath])
  })

  it('dedupes an identical plan against the live subscription', async () => {
    await svc.watch(root, { scopes: [client, server] })
    await svc.watch(root, { scopes: [server, client] }) // same set, different order
    expect(host.watch).toHaveBeenCalledTimes(2)
  })

  it('reuses surviving ids and releases only the dropped target', async () => {
    await svc.watch(root, { scopes: [client, server] })
    const keptId = host.watch.mock.calls.find((c) => c[1] === client.fsPath)?.[0]
    const droppedId = host.watch.mock.calls.find((c) => c[1] === server.fsPath)?.[0]
    const before = host.watch.mock.calls.length

    const narrowed = svc.watch(root, { scopes: [client] })
    await vi.advanceTimersByTimeAsync(500)
    await narrowed

    expect(host.unwatch.mock.calls.map((c) => c[0])).toEqual([droppedId])
    // The surviving target keeps its id across the re-subscribe.
    expect(host.watch.mock.calls.slice(before).map((c) => c[0])).toEqual([keptId])
  })

  it('routes events from every subscribed id, not just the primary', async () => {
    const fileEvents = new Emitter<{
      id: number
      events: readonly { path: string; type: 'create' | 'update' | 'delete' }[]
    }>()
    const multiHost = {
      ...createStubHost(),
      onFileEvents: fileEvents.event,
    }
    const multiSvc = new FileWatcherMainService(multiHost as unknown as WatcherProcessClient)
    try {
      await multiSvc.watch(root, { scopes: [client, server] })
      const ids = multiHost.watch.mock.calls.map((c) => c[0] as number)
      const batches: IFileChangeEvent[] = []
      const sub = multiSvc.onDidChangeFiles((b) => batches.push(...b))
      for (const id of ids) {
        fileEvents.fire({ id, events: [{ path: `/w/root/x-${id}.txt`, type: 'create' }] })
      }
      multiSvc._flushForTests()
      sub.dispose()
      expect(batches.length).toBe(ids.length)
    } finally {
      multiSvc.dispose()
    }
  })

  it('arms a non-recursive root watch only when includeRootFiles is set', async () => {
    // fs.watch on a non-existent dir is caught and warned; what matters here is
    // that the plan (not the realized watcher) drives dedupe, so a repeat call
    // with the same intent must not re-subscribe.
    await svc.watch(root, { scopes: [client], includeRootFiles: true })
    const before = host.watch.mock.calls.length
    await svc.watch(root, { scopes: [client], includeRootFiles: true })
    expect(host.watch).toHaveBeenCalledTimes(before)
  })

  it('treats a change to includeRootFiles as a different plan', async () => {
    await svc.watch(root, { scopes: [client] })
    void svc.watch(root, { scopes: [client], includeRootFiles: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(host.watch).toHaveBeenCalledTimes(2)
  })

  it('supersedes a pending scope change with a later one, landing only the last', async () => {
    await svc.watch(root, { scopes: [client] })
    const before = host.watch.mock.calls.length
    // Two concurrent changes inside one quiet window: the second must fully
    // replace the first, never land a mix of both plans.
    let firstLanded = false
    const first = svc.watch(root, { scopes: [server] }).then(() => {
      firstLanded = true
    })
    const second = svc.watch(root, { scopes: [client, server] })
    await vi.advanceTimersByTimeAsync(500)
    await first
    await second
    // A superseded waiter still resolves — its intent was replaced, which
    // satisfies watch()'s contract.
    expect(firstLanded).toBe(true)
    expect(watchTargets(before)).toEqual([client.fsPath, server.fsPath].sort())
  })

  it('coalesces an exclude storm during focus mode into one re-subscribe per target', async () => {
    await svc.watch(root, { scopes: [client, server] })
    const before = host.watch.mock.calls.length
    await svc.setExcludes(['**/b/**'])
    await svc.setExcludes(['**/c/**'])
    expect(host.watch).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(500)
    const after = host.watch.mock.calls.slice(before)
    expect(after.length).toBe(2)
    expect(watchTargets(before)).toEqual([client.fsPath, server.fsPath].sort())
    for (const call of after) expect(call[2]).toEqual(['**/c', '**/c/**'])
  })

  it('unwatch releases every id armed in focus mode', async () => {
    await svc.watch(root, { scopes: [client, server] })
    const armed = new Set(host.watch.mock.calls.map((c) => c[0]))
    await svc.unwatch()
    const released = new Set(host.unwatch.mock.calls.map((c) => c[0]))
    for (const id of armed) expect(released.has(id)).toBe(true)
  })

  it('routes an in-workspace folder interest into the plan, not an in-main fs.watch', async () => {
    // Focus hides Other/, but an extension that declared interest in it (git's
    // working-tree watcher over the whole repo) must keep getting its events.
    // It has to arrive as another host subscription: an in-main recursive
    // fs.watch on a workspace subtree would be unfiltered by excludes and is
    // exactly the shape the out-of-process watcher exists to avoid.
    const other = URI.file('/w/root/Other')
    await svc.watch(root, { scopes: [client], excludes: ['c'] })
    expect(watchTargets()).toEqual([client.fsPath])

    const from = host.watch.mock.calls.length
    const declared = svc.addOutOfWorkspaceFolder(other)
    await vi.advanceTimersByTimeAsync(500)
    await declared

    expect(svc._extraFolderWatcherCount).toBe(0)
    expect(watchTargets(from)).toEqual([client.fsPath, other.fsPath].sort())
    // Excludes still apply to it, unlike the fs.watch path.
    for (const call of host.watch.mock.calls.slice(from)) {
      expect(call[2]).toEqual(['c'])
    }
  })

  it('drops the interest target again once the interest is released', async () => {
    const other = URI.file('/w/root/Other')
    await svc.watch(root, { scopes: [client] })
    const added = svc.addOutOfWorkspaceFolder(other)
    await vi.advanceTimersByTimeAsync(500)
    await added
    expect(watchTargets(host.watch.mock.calls.length - 2)).toContain(other.fsPath)

    const from = host.watch.mock.calls.length
    const removed = svc.removeOutOfWorkspaceFolder(other)
    await vi.advanceTimersByTimeAsync(500)
    await removed
    // Back to the focus scope alone — the interest must not become permanent.
    expect(watchTargets(from)).toEqual([client.fsPath])
  })

  it('keeps genuinely out-of-workspace folders on their own fs.watch', async () => {
    // Real dirs: the out-of-workspace path arms a genuine fs.watch, which needs
    // the path (or at least its parent) to exist.
    vi.useRealTimers()
    const realRoot = await fs.mkdtemp(join(tmpdir(), 'universe-editor-focus-'))
    const outside = await fs.mkdtemp(join(tmpdir(), 'universe-editor-outside-'))
    await fs.mkdir(join(realRoot, 'Client', 'Deep'), { recursive: true })
    try {
      await svc.watch(URI.file(realRoot), { scopes: [URI.file(join(realRoot, 'Client'))] })
      await svc.addOutOfWorkspaceFolder(URI.file(outside))
      expect(svc._extraFolderWatcherCount).toBe(1)
      // A path already inside a live target needs nothing at all.
      await svc.addOutOfWorkspaceFolder(URI.file(join(realRoot, 'Client', 'Deep')))
      expect(svc._extraFolderWatcherCount).toBe(1)
    } finally {
      await svc.unwatch()
      await fs.rm(realRoot, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('releases an id whose watch threw, so crash replay cannot resurrect it', async () => {
    // The client records a subscription as desired BEFORE it can fail, so a
    // watch that throws leaves an entry the service no longer tracks — a host
    // restart would replay it as an orphan subscription.
    host.watch.mockImplementation(async (_id: number, dir: string) => {
      if (dir === server.fsPath) throw new Error('parcel refused')
    })
    await svc.watch(root, { scopes: [client, server] })

    const failedId = host.watch.mock.calls.find((c) => c[1] === server.fsPath)?.[0]
    expect(failedId).toBeDefined()
    expect(host.unwatch.mock.calls.map((c) => c[0])).toContain(failedId)
    // The target that did land is untouched.
    expect(host.unwatch.mock.calls.map((c) => c[0])).not.toContain(
      host.watch.mock.calls.find((c) => c[1] === client.fsPath)?.[0],
    )
  })

  it('releases what it armed when an unwatch lands mid-subscribe', async () => {
    // `_subscribe` arms one target at a time, so an unwatch can slip between
    // them. Whatever the interrupted pass already armed is nothing this window
    // tracks anymore, so it must release it rather than leave host subscriptions
    // (and crash-replay entries) behind.
    let unwatchDuringSubscribe: Promise<void> | undefined
    host.watch.mockImplementation(async (_id: number, dir: string) => {
      if (dir === client.fsPath && !unwatchDuringSubscribe) {
        unwatchDuringSubscribe = svc.unwatch()
      }
    })
    await svc.watch(root, { scopes: [client, server] })
    await unwatchDuringSubscribe

    // The second scope never got armed; the first one did and must be released.
    const armed = host.watch.mock.calls.map((c) => c[1])
    expect(armed).toContain(client.fsPath)
    const released = new Set(host.unwatch.mock.calls.map((c) => c[0]))
    const clientId = host.watch.mock.calls.find((c) => c[1] === client.fsPath)?.[0]
    expect(released.has(clientId as number)).toBe(true)
  })
})
