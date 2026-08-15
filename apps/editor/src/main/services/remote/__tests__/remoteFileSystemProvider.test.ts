/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/remoteFileSystemProvider.ts and
 *  the remote routing in fileSearchMainService.ts / textSearchMainService.ts.
 *  The harness mirrors the real server-side codec: the server channel uses
 *  binaryCodec + a remote-ssh<->file transformer, the client uses the plain
 *  binaryCodec — so URI translation happens in the codec, and the provider /
 *  search services are verified to pass URIs through verbatim.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  InMemoryMessagePassingProtocol,
  ProxyChannel,
  RemoteChannels,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEME,
  URI,
  binaryCodec,
  createBinaryCodec,
  createRemoteURITransformer,
  DisposableTracker,
  setDisposableTracker,
  type IFileSearchComplete,
  type IFileSearchQuery,
  type IFileSearchService,
  type IFileStat,
  type IRemoteEnvironment,
  type IRemoteFileStreamEvent,
  type IRemoteFileStreamService,
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

const ENV: IRemoteEnvironment = {
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

/** Wires a client/server channel pair; the server side transforms remote-ssh<->file
 *  exactly like the real daemon codec. Returns a fake connection service whose
 *  `getConnection` hands out the client side. */
function makeHarness(channels: Record<string, unknown>): {
  connService: IRemoteConnectionService
  close: Emitter<void>
  getConnectionCalls: () => number
  cleanup: () => void
} {
  const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
  const server = new ChannelServer(
    serverProto,
    true,
    createBinaryCodec(createRemoteURITransformer('host')),
  )
  const client = new ChannelClient(clientProto, true, binaryCodec)
  for (const [name, service] of Object.entries(channels)) {
    server.registerChannel(name, ProxyChannel.fromService(service as object))
  }
  const close = new Emitter<void>()
  let calls = 0
  const conn: IRemoteConnection = {
    authority: 'host',
    env: ENV,
    getChannel: (name) => client.getChannel(name),
    onDidClose: close.event,
  }
  const connService: IRemoteConnectionService = {
    _serviceBrand: undefined,
    getConnection: async () => {
      calls++
      return conn
    },
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

function makeStreamService(
  opts: {
    emit?: (ctx: {
      streamId: number
      size: number
      fire: (e: IRemoteFileStreamEvent) => void
    }) => void
    size?: number
    stat?: (resource: URI) => Promise<IFileStat>
    listRecursive?: (root: URI) => Promise<URI[]>
    realpath?: (resource: URI) => Promise<URI>
  } = {},
): {
  service: IRemoteFileStreamService
  startCalls: URI[]
  acks: Array<{ streamId: number; seq: number }>
  cancels: number[]
} {
  const emitter = new Emitter<IRemoteFileStreamEvent>()
  const startCalls: URI[] = []
  const acks: Array<{ streamId: number; seq: number }> = []
  const cancels: number[] = []
  let nextId = 1
  const fire = (e: IRemoteFileStreamEvent): void => emitter.fire(e)

  const service: IRemoteFileStreamService = {
    _serviceBrand: undefined,
    onReadStreamData: emitter.event,
    async startReadStream(resource: URI) {
      startCalls.push(resource)
      const streamId = nextId++
      const size = opts.size ?? 0
      opts.emit?.({ streamId, size, fire })
      return { streamId, size }
    },
    async ackReadStream(streamId, seq) {
      acks.push({ streamId, seq })
    },
    async cancelReadStream(streamId) {
      cancels.push(streamId)
    },
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat(resource) {
      if (opts.stat) return opts.stat(resource)
      return { resource, isFile: true, isDirectory: false, size: 0, mtime: 0 }
    },
    async list() {
      return []
    },
    async realpath(resource) {
      return opts.realpath?.(resource) ?? resource
    },
    async listDrives() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive(root) {
      return opts.listRecursive?.(root) ?? []
    },
  }
  return { service, startCalls, acks, cancels }
}

describe('RemoteFileSystemProvider', () => {
  it('passes remote-ssh URIs verbatim and receives codec-translated results', async () => {
    const { service, startCalls } = makeStreamService({
      size: 3,
      emit: ({ streamId, fire }) => {
        fire({ streamId, seq: 0, data: new Uint8Array([1, 2, 3]) })
        fire({ streamId, seq: 1, done: true })
      },
      stat: async () => ({
        resource: URI.file('/home/user/file.txt'),
        isFile: true,
        isDirectory: false,
        size: 3,
        mtime: 0,
      }),
      listRecursive: async () => [URI.file('/home/user/a.txt'), URI.file('/home/user/b.txt')],
      realpath: async () => URI.file('/home/user/file.txt'),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)

      const bytes = await provider.readFile(remote('host', '/home/user/file.txt'))
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
      // The provider sent remote-ssh; the server codec transformed it to file.
      expect(startCalls[0]!.scheme).toBe('file')
      expect(startCalls[0]!.path).toBe('/home/user/file.txt')

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
    const { service } = makeStreamService({
      size: 0,
      emit: ({ streamId, fire }) => fire({ streamId, seq: 0, done: true }),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
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

  it('sets capabilities from the connection env', async () => {
    const { service } = makeStreamService({
      size: 0,
      emit: ({ streamId, fire }) => fire({ streamId, seq: 0, done: true }),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      await provider.readFile(remote('host', '/a'))
      expect(provider.capabilities.pathCaseSensitive).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})

describe('RemoteFileSystemProvider streaming readFile', () => {
  it('reassembles multiple chunks and acks each one', async () => {
    const { service, acks } = makeStreamService({
      size: 6,
      emit: ({ streamId, fire }) => {
        fire({ streamId, seq: 0, data: new Uint8Array([1, 2, 3]) })
        fire({ streamId, seq: 1, data: new Uint8Array([4, 5, 6]) })
        fire({ streamId, seq: 2, done: true })
      },
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      const bytes = await provider.readFile(remote('host', '/a'))
      expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
      expect(acks).toEqual([
        { streamId: 1, seq: 0 },
        { streamId: 1, seq: 1 },
      ])
    } finally {
      h.cleanup()
    }
  })

  it('rejects on a stream error and passes the code through', async () => {
    const { service } = makeStreamService({
      size: 10,
      emit: ({ streamId, fire }) =>
        fire({ streamId, seq: 0, error: { message: 'boom', code: 'EACCES' } }),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      const err = await provider.readFile(remote('host', '/a')).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('boom')
      expect((err as { code?: string }).code).toBe('EACCES')
    } finally {
      h.cleanup()
    }
  })

  it('rejects on an out-of-order seq and cancels the stream', async () => {
    const { service, cancels } = makeStreamService({
      size: 9,
      emit: ({ streamId, fire }) => {
        fire({ streamId, seq: 0, data: new Uint8Array([1, 2, 3]) })
        fire({ streamId, seq: 2, data: new Uint8Array([7, 8, 9]) })
      },
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      await expect(provider.readFile(remote('host', '/a'))).rejects.toThrow(/out-of-order/)
      expect(cancels).toEqual([1])
    } finally {
      h.cleanup()
    }
  })

  it('rejects pending streams when the connection closes', async () => {
    const { service } = makeStreamService({
      size: 10,
      emit: ({ streamId, fire }) => fire({ streamId, seq: 0, data: new Uint8Array([1, 2, 3]) }),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    try {
      const provider = new RemoteFileSystemProvider(h.connService, undefined)
      const pending = provider.readFile(remote('host', '/a'))
      await flushMicrotasks()
      h.close.fire()
      await expect(pending).rejects.toThrow(/connection closed/)
    } finally {
      h.cleanup()
    }
  })
})

describe('FileSearchMainService remote routing', () => {
  it('sends the root verbatim (codec transforms) and returns remote-ssh hits', async () => {
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

  it('sends the root verbatim and returns remote-ssh file matches', async () => {
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

  it('forwards remote progress/results events with codec-translated resources', async () => {
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

describe('remote service disposable ownership', () => {
  async function expectNoLeaks(fn: () => void | Promise<void>): Promise<void> {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      await fn()
    } finally {
      const report = tracker.computeLeakingDisposables()
      setDisposableTracker(null)
      expect(report).toBeUndefined()
    }
  }

  it('releases the provider connection subscriptions on dispose', async () => {
    const { service } = makeStreamService({
      size: 0,
      emit: ({ streamId, fire }) => fire({ streamId, seq: 0, done: true }),
    })
    const h = makeHarness({ [RemoteChannels.FileSystem]: service })
    const provider = new RemoteFileSystemProvider(h.connService, undefined)
    try {
      await expectNoLeaks(async () => {
        await provider.readFile(remote('host', '/a'))
        provider.dispose()
      })
    } finally {
      h.cleanup()
    }
  })

  it('releases the file search onDidClose subscription on dispose', async () => {
    const stub: Partial<IFileSearchService> = {
      async search(): Promise<IFileSearchComplete> {
        return { results: [], limitHit: false, filesWalked: 0, directoriesWalked: 0, durationMs: 0 }
      },
    }
    const h = makeHarness({ [RemoteChannels.FileSearch]: stub })
    const svc = new FileSearchMainService(undefined, h.connService)
    try {
      await expectNoLeaks(async () => {
        await svc.search({ root: remote('host', '/x'), pattern: 'a' })
        svc.dispose()
      })
    } finally {
      h.cleanup()
    }
  })

  it('releases the text search subscriptions on dispose', async () => {
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
    const svc = new TextSearchMainService(undefined, h.connService)
    try {
      await expectNoLeaks(async () => {
        await svc.search({
          sessionId: 's1',
          root: remote('host', '/x'),
          pattern: 'foo',
          isRegex: false,
          matchCase: false,
          matchWholeWord: false,
          includes: [],
          excludes: [],
          configurationExcludes: [],
        })
        svc.dispose()
      })
    } finally {
      h.cleanup()
    }
  })
})
