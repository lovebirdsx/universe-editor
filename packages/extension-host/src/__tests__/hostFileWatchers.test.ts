/*---------------------------------------------------------------------------------------------
 *  HostFileWatcherRegistry: renderer file-event batches are matched against each
 *  watcher's compiled glob over the workspace-relative path; interest is declared
 *  to the renderer only while at least one watcher is alive.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { IMainThreadFileEvents } from '@universe-editor/extensions-common'
import { HostFileWatcherRegistry } from '../hostFileWatchers.js'

function fakeMainThread(): IMainThreadFileEvents & {
  subscribeCount: number
  unsubscribeCount: number
} {
  const state = {
    subscribeCount: 0,
    unsubscribeCount: 0,
    $subscribeFileEvents: () => {
      state.subscribeCount++
      return Promise.resolve()
    },
    $unsubscribeFileEvents: () => {
      state.unsubscribeCount++
      return Promise.resolve()
    },
  }
  return state
}

const root = '/ws'

describe('HostFileWatcherRegistry', () => {
  it('subscribes on the first watcher and unsubscribes when the last one disposes', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    expect(mt.subscribeCount).toBe(0)

    const a = registry.createWatcher('**/*.ts', false, false, false)
    const b = registry.createWatcher('**/*.md', false, false, false)
    expect(mt.subscribeCount).toBe(1)

    a.dispose()
    expect(mt.unsubscribeCount).toBe(0)
    b.dispose()
    expect(mt.unsubscribeCount).toBe(1)

    // Disposing again is a no-op.
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

  it('dispose() releases every watcher and unsubscribes', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    registry.createWatcher('**/*.ts', false, false, false)
    expect(mt.subscribeCount).toBe(1)
    registry.dispose()
    expect(mt.unsubscribeCount).toBe(1)
    // Late events reach no one.
    registry.acceptFileEvents([{ type: 'created', uri: URI.file('/ws/a.ts').toJSON() }])
  })
})
