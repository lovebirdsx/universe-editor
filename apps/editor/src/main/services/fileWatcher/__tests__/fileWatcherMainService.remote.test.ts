/*---------------------------------------------------------------------------------------------
 *  Tests for the remote watcher routing in
 *  apps/editor/src/main/services/fileWatcher/fileWatcherMainService.ts.
 *  The remote client is a real WatcherProcessClient whose transport is tunnelled
 *  over a stub IRemoteWatcherTunnel, so subscribe/replay/event mapping run through
 *  the real machinery with no utility process.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  ProxyChannel,
  RemoteChannels,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEME,
  URI,
  type IFileChangeEvent,
  type IRemoteEnvironment,
  type IRemoteWatcherTunnel,
  type WatcherHostRequest,
  type WatcherHostResponse,
  type WatcherSubscribeRequest,
} from '@universe-editor/platform'
import { WatcherProcessClient } from '@universe-editor/node-services'
import type {
  IRemoteConnection,
  IRemoteConnectionService,
} from '../../remote/remoteConnectionMainService.js'
import { FileWatcherMainService } from '../fileWatcherMainService.js'

const INFO: IRemoteEnvironment = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  serverVersion: '0.0.0',
  os: 'linux',
  arch: 'x64',
  nodeVersion: '20.0.0',
  pathCaseSensitive: true,
  homeDir: '/home/u',
  tmpDir: '/tmp',
}

function remote(authority: string, path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function makeWatcherHarness(): {
  svc: FileWatcherMainService
  newService: () => FileWatcherMainService
  tunnelMessages: Emitter<WatcherHostResponse>
  tunnelPosts: WatcherHostRequest[]
  close: Emitter<void>
  cleanup: () => void
} {
  const tunnelMessages = new Emitter<WatcherHostResponse>()
  const tunnelPosts: WatcherHostRequest[] = []
  const stubTunnel: IRemoteWatcherTunnel = {
    onMessage: tunnelMessages.event,
    post: async (msg) => {
      tunnelPosts.push(msg)
    },
  }
  const close = new Emitter<void>()
  const conn: IRemoteConnection = {
    authority: 'host',
    env: INFO,
    getChannel: (name) => {
      expect(name).toBe(RemoteChannels.FileWatcher)
      return ProxyChannel.fromService(stubTunnel)
    },
    onDidClose: close.event,
  }
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getState: () => undefined,
    getConnection: async () => conn,
    connect: async () => conn,
    openExtensionHostConnection: async () => {
      throw new Error('not used in this test')
    },
    onDidChangeState: Event.None,
    retryConnection: () => undefined,
    stopServer: async () => undefined,
    closeConnection: async () => undefined,
    dropSocketForTesting: () => undefined,
    dropExtensionHostSocketForTesting: () => undefined,
    dispose: () => undefined,
    getServiceProxy: () => {
      throw new Error('not stubbed')
    },
  }
  const localHost = new WatcherProcessClient(() => {
    throw new Error('local watcher transport must not be used in remote tests')
  })
  const services: FileWatcherMainService[] = []
  const newService = (): FileWatcherMainService => {
    const service = new FileWatcherMainService(localHost, undefined, connService)
    services.push(service)
    return service
  }
  const svc = newService()
  return {
    svc,
    newService,
    tunnelMessages,
    tunnelPosts,
    close,
    cleanup: () => {
      for (const service of services.splice(0)) service.dispose()
      localHost.dispose()
      close.dispose()
      tunnelMessages.dispose()
    },
  }
}

describe('FileWatcherMainService remote routing', () => {
  it('subscribes with the server-side path and maps event paths to remote-ssh URIs', async () => {
    const h = makeWatcherHarness()
    const changes: IFileChangeEvent[] = []
    h.svc.onDidChangeFiles((e) => changes.push(...e))

    const watching = h.svc.watch(remote('host', '/home/user'), { excludes: ['**/node_modules/**'] })
    await flushMicrotasks()
    const sub = h.tunnelPosts[0] as WatcherSubscribeRequest | undefined
    expect(sub?.kind).toBe('subscribe')
    expect(sub?.dir).toBe('/home/user')
    expect(sub?.ignore).toEqual(['**/node_modules', '**/node_modules/**'])

    h.tunnelMessages.fire({ kind: 'ack', seq: sub!.seq })
    await watching

    h.tunnelMessages.fire({
      kind: 'events',
      id: sub!.id,
      events: [{ path: 'C:\\home\\user\\file.txt', type: 'create' }],
    })
    h.svc._flushForTests()

    expect(changes).toHaveLength(1)
    expect(changes[0]!.type).toBe('added')
    expect(changes[0]!.resource.scheme).toBe(REMOTE_SCHEME)
    expect(changes[0]!.resource.authority).toBe('host')
    expect(changes[0]!.resource.path).toBe('/C:/home/user/file.txt')

    h.cleanup()
  })

  it('gives windows sharing an authority distinct watcher ids and isolated subscriptions', async () => {
    const h = makeWatcherHarness()
    const svcB = h.newService()
    const changesA: IFileChangeEvent[] = []
    const changesB: IFileChangeEvent[] = []
    h.svc.onDidChangeFiles((e) => changesA.push(...e))
    svcB.onDidChangeFiles((e) => changesB.push(...e))

    const watchingA = h.svc.watch(remote('host', '/home/user/a'))
    const watchingB = svcB.watch(remote('host', '/home/user/b'))
    await flushMicrotasks()
    const subs = h.tunnelPosts.filter(
      (msg): msg is WatcherSubscribeRequest => msg.kind === 'subscribe',
    )
    expect(subs).toHaveLength(2)
    const [subA, subB] = subs
    // Both windows tunnel into the same connection, so the server sees one
    // watcher keyed by id; duplicate ids would have them evict each other.
    expect(subA!.id).not.toBe(subB!.id)

    h.tunnelMessages.fire({ kind: 'ack', seq: subA!.seq })
    h.tunnelMessages.fire({ kind: 'ack', seq: subB!.seq })
    await Promise.all([watchingA, watchingB])

    h.tunnelMessages.fire({
      kind: 'events',
      id: subA!.id,
      events: [{ path: '/home/user/a/only-a.txt', type: 'create' }],
    })
    h.svc._flushForTests()
    svcB._flushForTests()
    expect(changesA.map((c) => c.resource.path)).toEqual(['/home/user/a/only-a.txt'])
    expect(changesB).toHaveLength(0)

    h.svc.dispose()
    await flushMicrotasks()
    const unsubscribed = h.tunnelPosts.filter((msg) => msg.kind === 'unsubscribe')
    expect(unsubscribed.map((msg) => msg.id)).toEqual([subA!.id])

    h.tunnelMessages.fire({
      kind: 'events',
      id: subB!.id,
      events: [{ path: '/home/user/b/still-watched.txt', type: 'update' }],
    })
    svcB._flushForTests()
    expect(changesB.map((c) => c.resource.path)).toEqual(['/home/user/b/still-watched.txt'])

    h.cleanup()
  })

  it('replays the subscription after the connection closes', async () => {
    vi.useFakeTimers()
    try {
      const h = makeWatcherHarness()
      const watching = h.svc.watch(remote('host', '/home/user'))
      await flushMicrotasks()
      const sub = h.tunnelPosts[0] as WatcherSubscribeRequest
      h.tunnelMessages.fire({ kind: 'ack', seq: sub.seq })
      await watching

      h.close.fire()
      await flushMicrotasks()
      expect(h.tunnelPosts).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      expect(h.tunnelPosts.length).toBeGreaterThan(1)
      const replay = h.tunnelPosts[h.tunnelPosts.length - 1] as WatcherSubscribeRequest
      expect(replay.kind).toBe('subscribe')
      expect(replay.dir).toBe('/home/user')
      // Reconnected transports must resume the same id, not allocate a new one.
      expect(replay.id).toBe(sub.id)
      h.cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps astral event paths and keeps the rest of the batch when one path is unusable', async () => {
    const h = makeWatcherHarness()
    const changes: IFileChangeEvent[] = []
    h.svc.onDidChangeFiles((e) => changes.push(...e))

    const watching = h.svc.watch(remote('host', '/home/user'))
    await flushMicrotasks()
    const sub = h.tunnelPosts[0] as WatcherSubscribeRequest
    h.tunnelMessages.fire({ kind: 'ack', seq: sub.seq })
    await watching

    h.tunnelMessages.fire({
      kind: 'events',
      id: sub.id,
      events: [
        { path: '/home/user/🎉.txt', type: 'create' },
        // A lone surrogate cannot be encoded into a URI at all; dropping it must
        // not swallow the paths that follow in the same message.
        { path: '/home/user/\uD83C.txt', type: 'update' },
        { path: '/home/user/plain.txt', type: 'delete' },
      ],
    })
    h.svc._flushForTests()

    expect(changes.map((c) => c.resource.path)).toEqual([
      '/home/user/🎉.txt',
      '/home/user/plain.txt',
    ])
    h.cleanup()
  })
})
