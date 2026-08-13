/*---------------------------------------------------------------------------------------------
 *  Tests for packages/remote-server/src/server.ts
 *
 *  Drive a full server over an in-memory protocol pair: one ChannelPair hosts the
 *  server (createRemoteServer), the other is the client (ProxyChannel.toService).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ChannelPair,
  InMemoryMessagePassingProtocol,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  URI,
  type IFileSearchService,
  type IFileService,
  type IRemoteHandshakeService,
  type IRemoteWatcherTunnel,
  type ITextSearchMainService,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import { createRemoteServer } from '../server.js'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-remote-server-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

function connect(): {
  getClient: <T extends object>(name: string) => T
  dispose: () => void
} {
  const [a, b] = InMemoryMessagePassingProtocol.createPair()
  const serverPair = new ChannelPair(a)
  const clientPair = new ChannelPair(b)
  const serverDisposable = createRemoteServer(serverPair.server)
  return {
    getClient: <T extends object>(name: string) =>
      ProxyChannel.toService<T>(clientPair.client.getChannel(name)),
    dispose: () => {
      serverDisposable.dispose()
      serverPair.dispose()
      clientPair.dispose()
      a.disconnect()
      b.disconnect()
    },
  }
}

function nextAck(tunnel: IRemoteWatcherTunnel, seq: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for seq ${seq}`)), timeoutMs)
    const sub = tunnel.onMessage((msg: WatcherHostResponse) => {
      if (msg.kind === 'ack' && msg.seq === seq) {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      }
    })
  })
}

describe('createRemoteServer', () => {
  it('handshake returns the protocol version and host platform info', async () => {
    const { getClient, dispose } = connect()
    try {
      const handshake = getClient<IRemoteHandshakeService>(RemoteChannels.Handshake)
      const info = await handshake.getInfo()
      expect(info.protocolVersion).toBe(REMOTE_PROTOCOL_VERSION)
      expect(info.os).toBe(process.platform)
      expect(info.arch).toBe(process.arch)
      expect(info.pathCaseSensitive).toBe(process.platform === 'linux')
    } finally {
      dispose()
    }
  })

  it('round-trips write/read/stat/list/listRecursive/delete over fileSystem', async () => {
    const root = await makeTempRoot()
    const { getClient, dispose } = connect()
    const fileService = getClient<IFileService>(RemoteChannels.FileSystem)
    try {
      const dir = URI.file(path.join(root, 'sub'))
      await fileService.createDirectory(dir)

      const file = URI.file(path.join(root, 'sub', 'a.txt'))
      await fileService.writeFile(file, 'hello remote')
      expect(await fileService.readFileText(file)).toBe('hello remote')

      const stat = await fileService.stat(file)
      expect(stat.isFile).toBe(true)
      expect(stat.size).toBe('hello remote'.length)

      const listing = await fileService.list(dir)
      expect(listing.map((e) => e.name).sort()).toEqual(['a.txt'])

      const recursive = await fileService.listRecursive(URI.file(root))
      expect(recursive.length).toBe(1)
      // URIs survive the wire as real instances with the file: scheme.
      expect(recursive[0]!.scheme).toBe('file')
      expect(path.normalize(recursive[0]!.fsPath)).toBe(path.normalize(file.fsPath))

      await fileService.delete(file)
      expect(await fileService.exists(file)).toBe(false)
    } finally {
      dispose()
    }
  })

  it('delete with useTrash throws UNKNOWN (remote host has no trash hook)', async () => {
    const root = await makeTempRoot()
    const filePath = path.join(root, 'x.txt')
    await writeFile(filePath, 'x')

    const { getClient, dispose } = connect()
    const fileService = getClient<IFileService>(RemoteChannels.FileSystem)
    try {
      const err = await fileService.delete(URI.file(filePath), { useTrash: true }).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as { code?: string }).code).toBe('UNKNOWN')
      expect(await fileService.exists(URI.file(filePath))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('fileWatcher tunnel acks subscribe and unsubscribe', async () => {
    const root = await makeTempRoot()
    const { getClient, dispose } = connect()
    const tunnel = getClient<IRemoteWatcherTunnel>(RemoteChannels.FileWatcher)
    try {
      const ack0 = nextAck(tunnel, 0)
      await tunnel.post({ kind: 'subscribe', seq: 0, id: 1, dir: root, ignore: [] })
      await ack0

      const ack1 = nextAck(tunnel, 1)
      await tunnel.post({ kind: 'unsubscribe', seq: 1, id: 1 })
      await ack1
    } finally {
      dispose()
    }
  }, 15000)

  it('textSearch and fileSearch find real ripgrep hits over the wire', async () => {
    const root = await makeTempRoot()
    await writeFile(path.join(root, 'alpha.ts'), 'const needleToken = 1\n')
    await writeFile(path.join(root, 'beta.txt'), 'needleToken appears here too\n')

    const { getClient, dispose } = connect()
    try {
      const textSearch = getClient<ITextSearchMainService>(RemoteChannels.TextSearch)
      const complete = await textSearch.search({
        sessionId: 'remote-test',
        root: URI.file(root).toJSON(),
        pattern: 'needleToken',
        isRegex: false,
        matchCase: true,
        matchWholeWord: false,
        includes: [],
        excludes: [],
        configurationExcludes: [],
      })
      expect(complete.results.length).toBe(2)
      expect(complete.results.map((r) => URI.revive(r.resource)!.scheme)).toEqual(['file', 'file'])

      const fileSearch = getClient<IFileSearchService>(RemoteChannels.FileSearch)
      const fileResult = await fileSearch.search({ root: URI.file(root), pattern: 'alpha' })
      expect(fileResult.results.length).toBe(1)
      expect(fileResult.results[0]!.basename).toBe('alpha.ts')
    } finally {
      dispose()
    }
  }, 20000)
})
