/*---------------------------------------------------------------------------------------------
 *  MainThreadFileEvents: the host declares unique (base, pattern) interests
 *  (0↔n on its side); this stage pre-filters event batches against them — an
 *  event no live watcher could match never crosses the wire. Out-of-workspace
 *  bases arm reference-counted recursive folder watches, except patterns
 *  anchoring exactly one file, which use the cheap file-level watch.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  normalizePlatform,
  NullLogger,
  URI,
  UriIdentityService,
  type IDisposable,
  type IFileChangeEvent,
  type IFileWatcherService,
} from '@universe-editor/platform'
import type { IFileChangeEventDto, IExtHostFileEvents } from '@universe-editor/extensions-common'
import type { IOutOfWorkspaceWatchService } from '../../files/outOfWorkspaceWatchService.js'
import { MainThreadFileEvents } from '../MainThreadFileEvents.js'

function fakeWatcher(): IFileWatcherService & {
  folders: URI[]
  added: URI[]
  removed: URI[]
  clearCalls: number
  fire(events: IFileChangeEvent[]): void
} {
  const emitter = new Emitter<readonly IFileChangeEvent[]>()
  const state = {
    folders: [] as URI[],
    added: [] as URI[],
    removed: [] as URI[],
    clearCalls: 0,
    fire: (events: IFileChangeEvent[]) => emitter.fire(events),
    watch: () => Promise.resolve(),
    setExcludes: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    watchOutOfWorkspace: () => Promise.resolve(),
    addOutOfWorkspaceFolder: (folder: URI) => {
      state.added.push(folder)
      state.folders.push(folder)
      return Promise.resolve()
    },
    removeOutOfWorkspaceFolder: (folder: URI) => {
      state.removed.push(folder)
      const idx = state.folders.findIndex((f) => f.toString() === folder.toString())
      if (idx >= 0) state.folders.splice(idx, 1)
      return Promise.resolve()
    },
    clearOutOfWorkspaceFolders: () => {
      state.clearCalls++
      state.folders.length = 0
      return Promise.resolve()
    },
    onDidChangeFiles: emitter.event,
    onDidRestart: Event.None,
    _serviceBrand: undefined,
  }
  return state
}

function fakeFileWatch(): IOutOfWorkspaceWatchService & {
  watched: URI[][]
  disposedCount: number
} {
  const state = {
    watched: [] as URI[][],
    disposedCount: 0,
    watch: (uris: readonly URI[]): IDisposable => {
      state.watched.push([...uris])
      return {
        dispose: () => {
          state.disposedCount++
        },
      }
    },
    _serviceBrand: undefined,
  }
  return state
}

function fakeExtHost(): IExtHostFileEvents & { batches: IFileChangeEventDto[][] } {
  const batches: IFileChangeEventDto[][] = []
  return {
    batches,
    $acceptFileEvents: (events) => {
      batches.push([...events])
      return Promise.resolve()
    },
  }
}

const platform = normalizePlatform(process.platform)

function makeMainThread(workspaceRoot: string | undefined = '/ws') {
  const watcher = fakeWatcher()
  const fileWatch = fakeFileWatch()
  const extHost = fakeExtHost()
  const mt = new MainThreadFileEvents(
    watcher,
    extHost,
    new NullLogger(),
    new UriIdentityService(platform),
    fileWatch,
    workspaceRoot,
  )
  return { watcher, fileWatch, extHost, mt }
}

describe('MainThreadFileEvents', () => {
  it('arms an out-of-workspace folder watch on the first based interest, releases it on the last', async () => {
    const { watcher, mt } = makeMainThread()
    const interest = { base: URI.file('/outside/logs').toJSON(), pattern: '**/*.log' }

    await mt.$subscribeFileEvents(interest)
    expect(watcher.added.map((u) => u.fsPath)).toEqual(['/outside/logs'])

    await mt.$unsubscribeFileEvents(interest)
    expect(watcher.removed.map((u) => u.fsPath)).toEqual(['/outside/logs'])
    expect(watcher.folders).toEqual([])
  })

  it('shares one folder watch across different patterns with the same base', async () => {
    const { watcher, mt } = makeMainThread()
    const base = URI.file('/outside').toJSON()

    await mt.$subscribeFileEvents({ base, pattern: '*.log' })
    await mt.$subscribeFileEvents({ base, pattern: '*.txt' })
    expect(watcher.added).toHaveLength(1)

    await mt.$unsubscribeFileEvents({ base, pattern: '*.log' })
    expect(watcher.removed).toHaveLength(0)

    await mt.$unsubscribeFileEvents({ base, pattern: '*.txt' })
    expect(watcher.removed).toHaveLength(1)
  })

  it('workspace interests (no base) never arm an extra watch', async () => {
    const { watcher, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: undefined, pattern: '**/*' })
    await mt.$unsubscribeFileEvents({ base: undefined, pattern: '**/*' })
    expect(watcher.added).toHaveLength(0)
    expect(watcher.removed).toHaveLength(0)
  })

  it('events matching no declared pattern never cross the wire', async () => {
    const { watcher, extHost, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: undefined, pattern: '**/*.log' })

    watcher.fire([{ type: 'modified', resource: URI.file('/ws/a.ts') }])
    watcher.fire([{ type: 'added', resource: URI.file('/ws/src/deep/b.log') }])
    expect(extHost.batches).toHaveLength(1)
    expect(extHost.batches[0]).toEqual([
      { type: 'created', uri: URI.file('/ws/src/deep/b.log').toJSON() },
    ])
  })

  it('pre-filters based interests by anchor and pattern', async () => {
    const { watcher, extHost, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: URI.file('/outside/logs').toJSON(), pattern: '*.log' })

    watcher.fire([
      // Matches the slashless basename glob at any depth under the base.
      { type: 'modified', resource: URI.file('/outside/logs/deep/a.log') },
      // Outside the base.
      { type: 'modified', resource: URI.file('/outside/b.log') },
      // Under the base but rejected by the pattern.
      { type: 'modified', resource: URI.file('/outside/logs/c.txt') },
    ])
    expect(extHost.batches).toHaveLength(1)
    expect(extHost.batches[0]).toEqual([
      { type: 'changed', uri: URI.file('/outside/logs/deep/a.log').toJSON() },
    ])
  })

  it('stops forwarding once all interests are dropped', async () => {
    const { watcher, extHost, mt } = makeMainThread()
    const interest = { base: URI.file('/outside').toJSON(), pattern: '*.log' }
    await mt.$subscribeFileEvents(interest)
    await mt.$unsubscribeFileEvents(interest)

    watcher.fire([{ type: 'modified', resource: URI.file('/outside/a.log') }])
    expect(extHost.batches).toHaveLength(0)
  })

  it('a slash-anchored literal pattern arms a file watch instead of a recursive folder watch', async () => {
    const { watcher, fileWatch, extHost, mt } = makeMainThread()
    const interest = { base: URI.file('/outside').toJSON(), pattern: 'cfg/app.txt' }

    await mt.$subscribeFileEvents(interest)
    expect(watcher.added).toHaveLength(0)
    expect(fileWatch.watched).toEqual([[URI.file('/outside/cfg/app.txt')]])

    watcher.fire([
      { type: 'modified', resource: URI.file('/outside/cfg/app.txt') },
      // A deeper match would suit a slashless literal — not an anchored one.
      { type: 'modified', resource: URI.file('/outside/x/cfg/app.txt') },
    ])
    expect(extHost.batches).toHaveLength(1)
    expect(extHost.batches[0]).toEqual([
      { type: 'changed', uri: URI.file('/outside/cfg/app.txt').toJSON() },
    ])

    await mt.$unsubscribeFileEvents(interest)
    expect(fileWatch.disposedCount).toBe(1)
    expect(watcher.removed).toHaveLength(0)
  })

  it('a slashless literal pattern still matches at any depth and keeps the folder watch', async () => {
    const { watcher, fileWatch, extHost, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: URI.file('/outside').toJSON(), pattern: 'app.txt' })

    expect(watcher.added.map((u) => u.fsPath)).toEqual(['/outside'])
    expect(fileWatch.watched).toHaveLength(0)

    watcher.fire([{ type: 'modified', resource: URI.file('/outside/deep/app.txt') }])
    expect(extHost.batches).toHaveLength(1)
  })

  it('ignores a non-file base instead of arming a watch', async () => {
    const { watcher, fileWatch, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: { scheme: 'untitled', path: '/x' }, pattern: '**/*' })
    expect(watcher.added).toHaveLength(0)
    expect(fileWatch.watched).toHaveLength(0)
  })

  it('an unsubscribe for an unknown interest is a no-op', async () => {
    const { watcher, mt } = makeMainThread()
    await mt.$unsubscribeFileEvents({ base: URI.file('/outside').toJSON(), pattern: '*.log' })
    expect(watcher.removed).toHaveLength(0)
  })

  it('dispose releases every armed folder watch and file-watch handle', async () => {
    const { watcher, fileWatch, mt } = makeMainThread()
    await mt.$subscribeFileEvents({ base: URI.file('/outside/a').toJSON(), pattern: '*.log' })
    await mt.$subscribeFileEvents({ base: URI.file('/outside/b').toJSON(), pattern: '*.txt' })
    await mt.$subscribeFileEvents({
      base: URI.file('/outside/c').toJSON(),
      pattern: 'cfg/app.txt',
    })
    expect(watcher.folders).toHaveLength(2)

    mt.dispose()
    expect(watcher.clearCalls).toBe(1)
    expect(watcher.folders).toHaveLength(0)
    expect(fileWatch.disposedCount).toBe(1)
  })
})
