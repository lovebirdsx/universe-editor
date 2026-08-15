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
    getConnection: async () => conn,
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
  }
  const localHost = new WatcherProcessClient(() => {
    throw new Error('local watcher transport must not be used in remote tests')
  })
  const svc = new FileWatcherMainService(localHost, undefined, connService)
  return {
    svc,
    tunnelMessages,
    tunnelPosts,
    close,
    cleanup: () => {
      svc.dispose()
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
      h.cleanup()
    } finally {
      vi.useRealTimers()
    }
  })
})
