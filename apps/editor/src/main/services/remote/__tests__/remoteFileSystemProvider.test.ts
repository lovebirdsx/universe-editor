/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/remoteFileSystemProvider.ts and
 *  the remote routing in fileSearchMainService.ts / textSearchMainService.ts.
 *  Uses an in-memory ChannelPair so a real IPC hop (URI revival, event bridging)
 *  is exercised end-to-end against stub server-side services — no process spawned.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  InMemoryMessagePassingProtocol,
  ProxyChannel,
  RemoteChannels,
  REMOTE_SCHEME,
  URI,
  type IFileSearchComplete,
  type IFileSearchQuery,
  type IFileSearchService,
  type IFileService,
  type IFileStat,
  type IRemoteHandshakeInfo,
  type ITextSearchMainComplete,
  type ITextSearchMainProgressEvent,
  type ITextSearchMainQuery,
  type ITextSearchMainResultsEvent,
  type ITextSearchMainService,
} from '@universe-editor/platform'
import type { IRemoteConnection, IRemoteConnectionService } from '../remoteConnectionMainService.js'
import { RemoteFileSystemProvider } from '../remoteFileSystemProvider.js'
import { FileSearchMainService } from '../../fileSearch/fileSearchMainService.js'
import { TextSearchMainService } from '../../textSearch/textSearchMainService.js'

const INFO: IRemoteHandshakeInfo = {
  protocolVersion: 1,
  os: 'linux',
  arch: 'x64',
  pathCaseSensitive: true,
}

function remote(authority: string, path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** Wires a client/server channel pair; registers `channels` on the server and
 *  returns a fake connection service whose `getConnection` hands out the client
 *  side. `getConnectionCalls` counts re-resolutions (cache-invalidation probe). */
function makeHarness(channels: Record<string, unknown>): {
  connService: IRemoteConnectionService
  close: Emitter<void>
  getConnectionCalls: () => number
  cleanup: () => void
} {
  const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
  const server = new ChannelServer(serverProto)
  const client = new ChannelClient(clientProto)
  for (const [name, service] of Object.entries(channels)) {
    server.registerChannel(name, ProxyChannel.fromService(service as object))
  }
  const close = new Emitter<void>()
  let calls = 0
  const conn: IRemoteConnection = {
    authority: 'host',
    info: INFO,
    getChannel: (name) => client.getChannel(name),
    onDidClose: close.event,
  }
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => {
      calls++
      return conn
    },
    dispose: () => undefined,
  }
  return {
    connService,
    close,
    getConnectionCalls: () => calls,
    cleanup: () => {
      client.dispose()
      server.dispose()
      close.dispose()
    },
  }
}

describe('RemoteFileSystemProvider', () => {
  it('forwards file: URIs and translates returned URIs back', async () => {
    const received: URI[] = []
    const stub: Partial<IFileService> = {
      async readFile(resource: URI) {
        received.push(resource)
        return new Uint8Array([1, 2, 3])
      },
      async stat(resource: URI): Promise<IFileStat> {
        received.push(resource)
        return {
          resource: URI.file('/home/user/file.txt'),
          isFile: true,
          isDirectory: false,
          size: 3,
          mtime: 0,
        }
      },
      async listRecursive(root: URI) {
        received.push(root)
        return [URI.file('/home/user/a.txt'), URI.file('/home/user/b.txt')]
      },
      async realpath(resource: URI) {
        received.push(resource)
        return URI.file('/home/user/file.txt')
      },
    }
    const h = makeHarness({ [RemoteChannels.FileSystem]: stub })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)

      const bytes = await provider.readFile(remote('host', '/home/user/file.txt'))
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
      expect(received[0]!.scheme).toBe('file')
      expect(received[0]!.path).toBe('/home/user/file.txt')

      const stat = await provider.stat(remote('host', '/home/user/file.txt'))
      expect(stat.resource.scheme).toBe(REMOTE_SCHEME)
      expect(stat.resource.authority).toBe('host')
      expect(stat.resource.path).toBe('/home/user/file.txt')

      const files = await provider.listRecursive(remote('host', '/home/user'))
      expect(files.map((f) => f.toString())).toEqual([
        remote('host', '/home/user/a.txt').toString(),
        remote('host', '/home/user/b.txt').toString(),
      ])

      const real = await provider.realpath(remote('host', '/home/user/file.txt'))
      expect(real.scheme).toBe(REMOTE_SCHEME)
      expect(real.authority).toBe('host')
    } finally {
      h.cleanup()
    }
  })

  it('re-resolves the proxy after the connection closes', async () => {
    const stub: Partial<IFileService> = {
      async readFile() {
        return new Uint8Array()
      },
    }
    const h = makeHarness({ [RemoteChannels.FileSystem]: stub })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      await provider.readFile(remote('host', '/a'))
      expect(h.getConnectionCalls()).toBe(1)
      h.close.fire()
      await provider.readFile(remote('host', '/b'))
      expect(h.getConnectionCalls()).toBe(2)
    } finally {
      h.cleanup()
    }
  })
})

describe('FileSearchMainService remote routing', () => {
  it('translates root to file: and result resources back to remote-ssh', async () => {
    const received: URI[] = []
    const stub: Partial<IFileSearchService> = {
      async search(query: IFileSearchQuery): Promise<IFileSearchComplete> {
        received.push(query.root)
        return {
          results: [
            {
              resource: URI.file('/home/user/a.txt'),
              fsPath: '/home/user/a.txt',
              relativePath: 'a.txt',
              basename: 'a.txt',
              score: 1,
            },
          ],
          limitHit: false,
          filesWalked: 1,
          directoriesWalked: 0,
          durationMs: 0,
        }
      },
    }
    const h = makeHarness({ [RemoteChannels.FileSearch]: stub })
    try {
      const svc = new FileSearchMainService(undefined, h.connService)
      const result = await svc.search({ root: remote('host', '/home/user'), pattern: 'a' })
      expect(received[0]!.scheme).toBe('file')
      expect(received[0]!.path).toBe('/home/user')
      expect(result.results[0]!.resource.scheme).toBe(REMOTE_SCHEME)
      expect(result.results[0]!.resource.authority).toBe('host')
    } finally {
      h.cleanup()
    }
  })
})

describe('TextSearchMainService remote routing', () => {
  const query = (sessionId: string): ITextSearchMainQuery => ({
    sessionId,
    root: remote('host', '/home/user'),
    pattern: 'foo',
    isRegex: false,
    matchCase: false,
    matchWholeWord: false,
    includes: [],
    excludes: [],
    configurationExcludes: [],
  })

  it('translates root and returned file matches', async () => {
    const received: URI[] = []
    const stub: Partial<ITextSearchMainService> = {
      async search(q: ITextSearchMainQuery): Promise<ITextSearchMainComplete> {
        received.push(q.root as URI)
        return {
          results: [{ resource: URI.file('/home/user/a.txt'), matches: [] }],
          progress: { filesScanned: 1, filesMatched: 1, totalMatches: 0 },
          durationMs: 0,
        }
      },
      async cancel() {},
    }
    const h = makeHarness({ [RemoteChannels.TextSearch]: stub })
    try {
      const svc = new TextSearchMainService(undefined, h.connService)
      const complete = await svc.search(query('s1'))
      expect(received[0]!.scheme).toBe('file')
      expect(received[0]!.path).toBe('/home/user')
      expect(complete.results[0]!.resource.scheme).toBe(REMOTE_SCHEME)
      expect(complete.results[0]!.resource.authority).toBe('host')
    } finally {
      h.cleanup()
    }
  })

  it('forwards remote progress/results events with translated resources', async () => {
    const progress = new Emitter<ITextSearchMainProgressEvent>()
    const results = new Emitter<ITextSearchMainResultsEvent>()
    const stub: Partial<ITextSearchMainService> = {
      onDidSearchProgress: progress.event,
      onDidSearchResults: results.event,
      async search(): Promise<ITextSearchMainComplete> {
        return {
          results: [],
          progress: { filesScanned: 0, filesMatched: 0, totalMatches: 0 },
          durationMs: 0,
        }
      },
      async cancel() {},
    }
    const h = makeHarness({ [RemoteChannels.TextSearch]: stub })
    try {
      const svc = new TextSearchMainService(undefined, h.connService)
      await svc.search(query('s1'))

      const seenResults: ITextSearchMainResultsEvent[] = []
      const seenProgress: ITextSearchMainProgressEvent[] = []
      const subs = [
        svc.onDidSearchResults((e) => seenResults.push(e)),
        svc.onDidSearchProgress((e) => seenProgress.push(e)),
      ]

      // Subscribe round-trips through the channel before the server forwards events.
      await flushMicrotasks()
      results.fire({
        sessionId: 's1',
        results: [{ resource: URI.file('/home/user/b.txt'), matches: [] }],
      })
      progress.fire({
        sessionId: 's1',
        progress: { filesScanned: 1, filesMatched: 1, totalMatches: 0 },
      })
      await flushMicrotasks()

      expect(seenResults).toHaveLength(1)
      expect(seenResults[0]!.results[0]!.resource.scheme).toBe(REMOTE_SCHEME)
      expect(seenResults[0]!.results[0]!.resource.authority).toBe('host')
      expect(seenProgress).toHaveLength(1)

      subs.forEach((s) => s.dispose())
    } finally {
      h.cleanup()
    }
  })

  it('routes cancel by session id while a remote search is in flight', async () => {
    const cancelled: string[] = []
    let resolveSearch!: (v: ITextSearchMainComplete) => void
    const gate = new Promise<ITextSearchMainComplete>((resolve) => {
      resolveSearch = resolve
    })
    const stub: Partial<ITextSearchMainService> = {
      async search(): Promise<ITextSearchMainComplete> {
        return gate
      },
      async cancel(sessionId: string) {
        cancelled.push(sessionId)
      },
    }
    const h = makeHarness({ [RemoteChannels.TextSearch]: stub })
    try {
      const svc = new TextSearchMainService(undefined, h.connService)
      const pending = svc.search(query('s1'))
      await flushMicrotasks()
      await svc.cancel('s1')
      expect(cancelled).toEqual(['s1'])
      resolveSearch({
        results: [],
        progress: { filesScanned: 0, filesMatched: 0, totalMatches: 0 },
        durationMs: 0,
      })
      await pending
    } finally {
      h.cleanup()
    }
  })
})
