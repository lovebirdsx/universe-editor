/*---------------------------------------------------------------------------------------------
 *  HostFileWatcherRegistry: renderer file-event batches are matched against each
 *  watcher's compiled glob over the anchor-relative path; interests are declared
 *  to the renderer as (base, pattern) pairs, reference-counted so only the 0↔n
 *  transitions cross the wire.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it, vi } from 'vitest'
import { URI, isCaseInsensitive, normalizePlatform } from '@universe-editor/platform'
import { RelativePattern } from '@universe-editor/extension-api'
import type {
  IFileWatcherInterestDto,
  IMainThreadFileEvents,
} from '@universe-editor/extensions-common'
import { HostFileWatcherRegistry } from '../hostFileWatchers.js'

function fakeMainThread(): IMainThreadFileEvents & {
  interests: Array<{ op: 'sub' | 'unsub'; interest: IFileWatcherInterestDto }>
  subscribeCount: number
  unsubscribeCount: number
} {
  const state = {
    interests: [] as Array<{ op: 'sub' | 'unsub'; interest: IFileWatcherInterestDto }>,
    subscribeCount: 0,
    unsubscribeCount: 0,
    $subscribeFileEvents: (interest: IFileWatcherInterestDto) => {
      state.subscribeCount++
      state.interests.push({ op: 'sub', interest })
      return Promise.resolve()
    },
    $unsubscribeFileEvents: (interest: IFileWatcherInterestDto) => {
      state.unsubscribeCount++
      state.interests.push({ op: 'unsub', interest })
      return Promise.resolve()
    },
  }
  return state
}

// `splitAbsoluteGlob` moved to extensions-common's glob module; its battery
// lives in packages/extensions-common/src/glob/__tests__/glob.test.ts.

const root = '/ws'

describe('HostFileWatcherRegistry', () => {
  it('declares one interest per unique pattern, workspace globs with an undefined base', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    expect(mt.subscribeCount).toBe(0)

    const a = registry.createWatcher('**/*.ts', false, false, false)
    const b = registry.createWatcher('**/*.md', false, false, false)
    expect(mt.subscribeCount).toBe(2)
    expect(mt.interests).toEqual([
      { op: 'sub', interest: { base: undefined, pattern: '**/*.ts' } },
      { op: 'sub', interest: { base: undefined, pattern: '**/*.md' } },
    ])

    a.dispose()
    expect(mt.unsubscribeCount).toBe(1)
    b.dispose()
    expect(mt.unsubscribeCount).toBe(2)

    // Disposing again is a no-op.
    b.dispose()
    expect(mt.unsubscribeCount).toBe(2)
  })

  it('coalesces identical interests: 50 watchers with the same glob cost one wire pair', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watchers = Array.from({ length: 50 }, () =>
      registry.createWatcher('**/*.ts', false, false, false),
    )
    expect(mt.subscribeCount).toBe(1)

    // A distinct pattern joins besides, and removing the 50 leaves it alone.
    const other = registry.createWatcher('**/*.md', false, false, false)
    expect(mt.subscribeCount).toBe(2)
    for (const w of watchers) w.dispose()
    expect(mt.unsubscribeCount).toBe(1)
    other.dispose()
    expect(mt.unsubscribeCount).toBe(2)
  })

  it('shares a base but not a pattern: two interests over the same base cost two wire pairs', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const a = registry.createWatcher(new RelativePattern('/outside', '*.log'), false, false, false)
    const b = registry.createWatcher(new RelativePattern('/outside', '*.txt'), false, false, false)
    expect(mt.subscribeCount).toBe(2)

    const c = registry.createWatcher(new RelativePattern('/outside', '*.log'), false, false, false)
    expect(mt.subscribeCount).toBe(2)

    a.dispose()
    expect(mt.unsubscribeCount).toBe(0) // c still holds the *.log lease
    c.dispose()
    b.dispose()
    expect(mt.unsubscribeCount).toBe(2)
  })

  it('folds case-insensitive base spellings into one interest (platform-dependent)', () => {
    const platform = normalizePlatform(process.platform)
    if (!isCaseInsensitive(platform)) return
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const a = registry.createWatcher(
      new RelativePattern('D:/Logs/Server', '*.log'),
      false,
      false,
      false,
    )
    const b = registry.createWatcher(
      new RelativePattern('d:/logs/server', '*.log'),
      false,
      false,
      false,
    )
    expect(mt.subscribeCount).toBe(1)
    a.dispose()
    b.dispose()
    expect(mt.unsubscribeCount).toBe(1)
  })

  it('fans events out to matching watchers by type', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher('**/*.ts', false, false, false)
    const created: string[] = []
    const changed: string[] = []
    const deleted: string[] = []
    watcher.onDidCreate((u) => created.push(u.path ?? ''))
    watcher.onDidChange((u) => changed.push(u.path ?? ''))
    watcher.onDidDelete((u) => deleted.push(u.path ?? ''))

    registry.acceptFileEvents([
      { type: 'created', uri: URI.file('/ws/src/a.ts').toJSON() },
      { type: 'changed', uri: URI.file('/ws/src/b.ts').toJSON() },
      { type: 'deleted', uri: URI.file('/ws/src/c.md').toJSON() },
    ])
    expect(created).toEqual([URI.file('/ws/src/a.ts').toJSON().path])
    expect(changed).toEqual([URI.file('/ws/src/b.ts').toJSON().path])
    expect(deleted).toEqual([]) // c.md does not match the glob
  })

  it('honours the ignore flags', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher('**/*.ts', true, true, false)
    const seen: string[] = []
    watcher.onDidCreate(() => seen.push('create'))
    watcher.onDidChange(() => seen.push('change'))
    watcher.onDidDelete(() => seen.push('delete'))

    registry.acceptFileEvents([
      { type: 'created', uri: URI.file('/ws/a.ts').toJSON() },
      { type: 'changed', uri: URI.file('/ws/a.ts').toJSON() },
      { type: 'deleted', uri: URI.file('/ws/a.ts').toJSON() },
    ])
    expect(seen).toEqual(['delete'])
  })

  it('drops events outside the workspace root', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher('**/*.ts', false, false, false)
    const seen = vi.fn()
    watcher.onDidCreate(seen)

    registry.acceptFileEvents([{ type: 'created', uri: URI.file('/elsewhere/a.ts').toJSON() }])
    expect(seen).not.toHaveBeenCalled()
  })

  it('matches nothing when no workspace folder is open', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, undefined)
    const watcher = registry.createWatcher('**/*.ts', false, false, false)
    const seen = vi.fn()
    watcher.onDidCreate(seen)

    registry.acceptFileEvents([{ type: 'created', uri: URI.file('/ws/a.ts').toJSON() }])
    expect(seen).not.toHaveBeenCalled()
  })

  it('a slashless glob matches the basename at any depth', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher('*.ts', false, false, false)
    const seen: string[] = []
    watcher.onDidChange((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([
      { type: 'changed', uri: URI.file('/ws/deep/nested/a.ts').toJSON() },
      { type: 'changed', uri: URI.file('/ws/deep/nested/a.js').toJSON() },
    ])
    expect(seen).toHaveLength(1)
  })

  it('dispose() releases every watcher and unsubscribes each unique interest once', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    registry.createWatcher('**/*.ts', false, false, false)
    registry.createWatcher('**/*.ts', false, false, false)
    registry.createWatcher(new RelativePattern('/outside', '*.log'), false, false, false)
    expect(mt.subscribeCount).toBe(2)
    registry.dispose()
    expect(mt.unsubscribeCount).toBe(2)
    // Late events reach no one.
    registry.acceptFileEvents([{ type: 'created', uri: URI.file('/ws/a.ts').toJSON() }])
  })

  it('a RelativePattern watcher matches its pattern against base-relative paths', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher(
      new RelativePattern('/ws/src', '*.ts'),
      false,
      false,
      false,
    )
    const seen: string[] = []
    watcher.onDidChange((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([
      // Under the base, any depth: matches the slashless basename glob.
      { type: 'changed', uri: URI.file('/ws/src/deep/a.ts').toJSON() },
      // Inside the workspace but outside the base: never matches.
      { type: 'changed', uri: URI.file('/ws/other/b.ts').toJSON() },
      // Under the base but the glob rejects it.
      { type: 'changed', uri: URI.file('/ws/src/c.md').toJSON() },
    ])
    expect(seen).toEqual([URI.file('/ws/src/deep/a.ts').toJSON().path])
  })

  it('a RelativePattern watcher whose base is the workspace root behaves like a string glob', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher(new RelativePattern('/ws', '*.ts'), false, false, false)
    const seen: string[] = []
    watcher.onDidChange((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([{ type: 'changed', uri: URI.file('/ws/anywhere/a.ts').toJSON() }])
    expect(seen).toHaveLength(1)
  })

  it('reports the (base, pattern) interest on subscribe so the renderer can pre-filter', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher(
      new RelativePattern('/outside/logs', '*.log'),
      false,
      false,
      false,
    )
    expect(mt.interests).toEqual([
      { op: 'sub', interest: { base: URI.file('/outside/logs').toJSON(), pattern: '*.log' } },
    ])
    watcher.dispose()
    expect(mt.interests).toEqual([
      { op: 'sub', interest: { base: URI.file('/outside/logs').toJSON(), pattern: '*.log' } },
      { op: 'unsub', interest: { base: URI.file('/outside/logs').toJSON(), pattern: '*.log' } },
    ])
  })

  it('an out-of-workspace RelativePattern watcher matches pushed events against base-relative paths', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher(
      new RelativePattern('/outside/logs', '*.log'),
      false,
      false,
      false,
    )
    const created: string[] = []
    const changed: string[] = []
    watcher.onDidCreate((u) => created.push(u.path ?? ''))
    watcher.onDidChange((u) => changed.push(u.path ?? ''))

    registry.acceptFileEvents([
      // Under the out-of-workspace base at any depth: matches.
      { type: 'created', uri: URI.file('/outside/logs/deep/a.log').toJSON() },
      { type: 'changed', uri: URI.file('/outside/logs/b.log').toJSON() },
      // Same glob shape but inside the workspace: not this watcher's anchor.
      { type: 'created', uri: URI.file('/ws/c.log').toJSON() },
      // The base folder itself ('' relative path) is not a file event.
      { type: 'changed', uri: URI.file('/outside/logs').toJSON() },
      // Under the base but the glob rejects it.
      { type: 'created', uri: URI.file('/outside/logs/d.txt').toJSON() },
    ])
    expect(created).toEqual([URI.file('/outside/logs/deep/a.log').toJSON().path])
    expect(changed).toEqual([URI.file('/outside/logs/b.log').toJSON().path])
  })

  it('an out-of-workspace RelativePattern watcher matches without any workspace folder', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, undefined)
    const watcher = registry.createWatcher(
      new RelativePattern('/outside', '*.ts'),
      false,
      false,
      false,
    )
    const seen: string[] = []
    watcher.onDidChange((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([{ type: 'changed', uri: URI.file('/outside/a.ts').toJSON() }])
    expect(seen).toHaveLength(1)
  })

  it('an absolute string glob subscribes with its inferred root and matches below it', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher('/outside/logs/**/*.log', false, false, false)
    expect(mt.interests).toEqual([
      {
        op: 'sub',
        interest: { base: URI.file('/outside/logs').toJSON(), pattern: '**/*.log' },
      },
    ])
    const seen: string[] = []
    watcher.onDidCreate((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([
      { type: 'created', uri: URI.file('/outside/logs/x/y/a.log').toJSON() },
      { type: 'created', uri: URI.file('/ws/a.log').toJSON() },
    ])
    expect(seen).toEqual([URI.file('/outside/logs/x/y/a.log').toJSON().path])
  })

  it('watchers sharing an anchor group all match against one relative-path computation', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const logs: string[] = []
    const texts: string[] = []
    registry
      .createWatcher(new RelativePattern('/outside/logs', '*.log'), false, false, false)
      .onDidChange((u) => logs.push(u.path ?? ''))
    registry
      .createWatcher(new RelativePattern('/outside/logs', '*.txt'), false, false, false)
      .onDidChange((u) => texts.push(u.path ?? ''))

    registry.acceptFileEvents([
      { type: 'changed', uri: URI.file('/outside/logs/a.log').toJSON() },
      { type: 'changed', uri: URI.file('/outside/logs/b.txt').toJSON() },
      { type: 'changed', uri: URI.file('/elsewhere/c.log').toJSON() },
    ])
    expect(logs).toEqual([URI.file('/outside/logs/a.log').toJSON().path])
    expect(texts).toEqual([URI.file('/outside/logs/b.txt').toJSON().path])
  })
})
