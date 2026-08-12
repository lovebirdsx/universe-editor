/*---------------------------------------------------------------------------------------------
 *  HostFileWatcherRegistry: renderer file-event batches are matched against each
 *  watcher's compiled glob over the workspace-relative path; interest is declared
 *  to the renderer only while at least one watcher is alive.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { RelativePattern } from '@universe-editor/extension-api'
import type { IMainThreadFileEvents } from '@universe-editor/extensions-common'
import type { UriComponents } from '@universe-editor/extension-api'
import { HostFileWatcherRegistry, splitAbsoluteGlob } from '../hostFileWatchers.js'

function fakeMainThread(): IMainThreadFileEvents & {
  bases: Array<{ op: 'sub' | 'unsub'; base: UriComponents | undefined }>
  subscribeCount: number
  unsubscribeCount: number
} {
  const state = {
    bases: [] as Array<{ op: 'sub' | 'unsub'; base: UriComponents | undefined }>,
    subscribeCount: 0,
    unsubscribeCount: 0,
    $subscribeFileEvents: (base: UriComponents | undefined) => {
      state.subscribeCount++
      state.bases.push({ op: 'sub', base })
      return Promise.resolve()
    },
    $unsubscribeFileEvents: (base: UriComponents | undefined) => {
      state.unsubscribeCount++
      state.bases.push({ op: 'unsub', base })
      return Promise.resolve()
    },
  }
  return state
}

const root = '/ws'

describe('splitAbsoluteGlob', () => {
  it('returns null for workspace-relative patterns', () => {
    expect(splitAbsoluteGlob('**/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('src/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('*.ts')).toBeNull()
    expect(splitAbsoluteGlob('./src/a.ts')).toBeNull()
    expect(splitAbsoluteGlob('../sibling/a.ts')).toBeNull()
  })

  it('splits a posix absolute glob into literal root + remaining pattern', () => {
    expect(splitAbsoluteGlob('/abs/logs/**/*.log')).toEqual({
      base: '/abs/logs',
      pattern: '**/*.log',
    })
  })

  it('splits a windows absolute glob (backslashes tolerated)', () => {
    expect(splitAbsoluteGlob('D:\\logs\\**\\*.log')).toEqual({
      base: 'D:/logs',
      pattern: '**/*.log',
    })
  })

  it('a glob-free absolute path targets the entry under its parent folder', () => {
    expect(splitAbsoluteGlob('/abs/config.json')).toEqual({
      base: '/abs',
      pattern: 'config.json',
    })
  })

  it('returns null when no literal prefix survives', () => {
    expect(splitAbsoluteGlob('/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('D:/**/*.ts')).toBeNull()
  })
})

describe('HostFileWatcherRegistry', () => {
  it('declares interest per watcher, workspace globs with an undefined base', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    expect(mt.subscribeCount).toBe(0)

    const a = registry.createWatcher('**/*.ts', false, false, false)
    const b = registry.createWatcher('**/*.md', false, false, false)
    expect(mt.subscribeCount).toBe(2)
    expect(mt.bases).toEqual([
      { op: 'sub', base: undefined },
      { op: 'sub', base: undefined },
    ])

    a.dispose()
    expect(mt.unsubscribeCount).toBe(1)
    b.dispose()
    expect(mt.unsubscribeCount).toBe(2)

    // Disposing again is a no-op.
    b.dispose()
    expect(mt.unsubscribeCount).toBe(2)
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

  it('reports the RelativePattern base on subscribe so the renderer can arm an out-of-workspace watch', () => {
    const mt = fakeMainThread()
    const registry = new HostFileWatcherRegistry(mt, root)
    const watcher = registry.createWatcher(
      new RelativePattern('/outside/logs', '*.log'),
      false,
      false,
      false,
    )
    expect(mt.bases).toEqual([{ op: 'sub', base: URI.file('/outside/logs').toJSON() }])
    watcher.dispose()
    expect(mt.bases).toEqual([
      { op: 'sub', base: URI.file('/outside/logs').toJSON() },
      { op: 'unsub', base: URI.file('/outside/logs').toJSON() },
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
    expect(mt.bases).toEqual([{ op: 'sub', base: URI.file('/outside/logs').toJSON() }])
    const seen: string[] = []
    watcher.onDidCreate((u) => seen.push(u.path ?? ''))

    registry.acceptFileEvents([
      { type: 'created', uri: URI.file('/outside/logs/x/y/a.log').toJSON() },
      { type: 'created', uri: URI.file('/ws/a.log').toJSON() },
    ])
    expect(seen).toEqual([URI.file('/outside/logs/x/y/a.log').toJSON().path])
  })
})
