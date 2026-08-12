/*---------------------------------------------------------------------------------------------
 *  MainThreadFileEvents: extension watchers anchored outside the workspace arm
 *  reference-counted out-of-workspace folder watches; events flow to the host
 *  only while interest is non-zero.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  normalizePlatform,
  NullLogger,
  URI,
  UriIdentityService,
  type IFileChangeEvent,
  type IFileWatcherService,
} from '@universe-editor/platform'
import type { IFileChangeEventDto, IExtHostFileEvents } from '@universe-editor/extensions-common'
import { MainThreadFileEvents } from '../MainThreadFileEvents.js'

function fakeWatcher(): IFileWatcherService & {
  folderCalls: URI[][]
  fire(events: IFileChangeEvent[]): void
} {
  const emitter = new Emitter<readonly IFileChangeEvent[]>()
  const folderCalls: URI[][] = []
  return {
    folderCalls,
    fire: (events) => emitter.fire(events),
    watch: () => Promise.resolve(),
    setExcludes: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    watchOutOfWorkspace: () => Promise.resolve(),
    watchOutOfWorkspaceFolders: (folders) => {
      folderCalls.push([...folders])
      return Promise.resolve()
    },
    onDidChangeFiles: emitter.event,
    onDidRestart: Event.None,
    _serviceBrand: undefined,
  }
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

function makeMainThread() {
  const watcher = fakeWatcher()
  const extHost = fakeExtHost()
  const mt = new MainThreadFileEvents(
    watcher,
    extHost,
    new NullLogger(),
    new UriIdentityService(platform),
  )
  return { watcher, extHost, mt }
}

describe('MainThreadFileEvents', () => {
  it('arms an out-of-workspace watch when a based watcher subscribes, clears it on the last unsubscribe', async () => {
    const { watcher, mt } = makeMainThread()
    const base = URI.file('/outside/logs').toJSON()

    await mt.$subscribeFileEvents(base)
    expect(watcher.folderCalls).toHaveLength(1)
    expect(watcher.folderCalls[0]!.map((u) => u.fsPath)).toEqual(['/outside/logs'])

    await mt.$unsubscribeFileEvents(base)
    expect(watcher.folderCalls).toHaveLength(2)
    expect(watcher.folderCalls[1]).toEqual([])
  })

  it('shares one folder watch across watchers with the same base', async () => {
    const { watcher, mt } = makeMainThread()
    const base = URI.file('/outside').toJSON()

    await mt.$subscribeFileEvents(base)
    await mt.$subscribeFileEvents(base)
    expect(watcher.folderCalls).toHaveLength(1)

    // One of two leaves: the watch stays armed, no redundant replace call.
    await mt.$unsubscribeFileEvents(base)
    expect(watcher.folderCalls).toHaveLength(1)

    await mt.$unsubscribeFileEvents(base)
    expect(watcher.folderCalls).toHaveLength(2)
    expect(watcher.folderCalls[1]).toEqual([])
  })

  it('workspace watchers (no base) never arm an extra watch', async () => {
    const { watcher, mt } = makeMainThread()
    await mt.$subscribeFileEvents(undefined)
    await mt.$unsubscribeFileEvents(undefined)
    expect(watcher.folderCalls).toHaveLength(0)
  })

  it('forwards out-of-workspace events through the same $acceptFileEvents pipeline', async () => {
    const { watcher, extHost, mt } = makeMainThread()
    await mt.$subscribeFileEvents(URI.file('/outside/logs').toJSON())

    watcher.fire([{ type: 'modified', resource: URI.file('/outside/logs/a.log') }])
    expect(extHost.batches).toHaveLength(1)
    expect(extHost.batches[0]).toEqual([
      { type: 'changed', uri: URI.file('/outside/logs/a.log').toJSON() },
    ])
  })

  it('stops forwarding once interest drops to zero', async () => {
    const { watcher, extHost, mt } = makeMainThread()
    const base = URI.file('/outside').toJSON()
    await mt.$subscribeFileEvents(base)
    await mt.$unsubscribeFileEvents(base)

    watcher.fire([{ type: 'modified', resource: URI.file('/outside/a.log') }])
    expect(extHost.batches).toHaveLength(0)
  })

  it('dispose releases every armed folder watch', async () => {
    const { watcher, mt } = makeMainThread()
    await mt.$subscribeFileEvents(URI.file('/outside/a').toJSON())
    await mt.$subscribeFileEvents(URI.file('/outside/b').toJSON())
    expect(watcher.folderCalls).toHaveLength(2)

    mt.dispose()
    expect(watcher.folderCalls).toHaveLength(3)
    expect(watcher.folderCalls[2]).toEqual([])
  })
})
