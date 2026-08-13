/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote server assembly: registers the five remote channels on an IChannelServer.
 *  Everything here is a headless local file-service stack — the server never sees a
 *  non-`file:` URI (the per-connection IPC codec translates remote-ssh URIs at the
 *  tunnel boundary). Services are built fresh for each connection so no state is
 *  shared across clients.
 *
 *  The parcel-native WatcherHost runs in a forked child (watcherChild.js) behind a
 *  WatcherProcessClient, so a native crash restarts the child instead of taking the
 *  daemon down. When the child entry is unavailable (tests running from source) the
 *  watcher falls back to an in-process host.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  DisposableStore,
  Emitter,
  FileService,
  NullLogger,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  type IChannelServer,
  type IDisposable,
  type ILogger,
  type ILoggerService,
  type IRemoteHandshakeService,
  type IRemoteWatcherTunnel,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import {
  createInMemoryWatcherTransport,
  FileSearchService,
  NodeFileSystemProvider,
  TextSearchService,
  WatcherProcessClient,
  type WatcherTransportFactory,
} from '@universe-editor/node-services'
import { ForkedWatcherTransport } from './watcherForkTransport.js'
import { RemoteFileStreamService } from './fileStreamService.js'
import { SERVER_VERSION } from './version.js'

export interface CreateRemoteServerOptions {
  readonly serverVersion?: string
  readonly watcherTransportFactory?: WatcherTransportFactory
}

export function createRemoteServer(
  server: IChannelServer,
  logger?: ILogger,
  options?: CreateRemoteServerOptions,
): IDisposable {
  const log = logger ?? new NullLogger()
  const disposables = new DisposableStore()

  // Route every `file:` resource to the local disk provider. No trash hook: the
  // remote host cannot reach the desktop's recycle bin, so useTrash fails loud.
  const fileProvider = new NodeFileSystemProvider({ logger: log })
  const fileService = new FileService()
  disposables.add(fileService.providers.register('file', fileProvider))

  const handshake: IRemoteHandshakeService = {
    getInfo: async () => ({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      serverVersion: options?.serverVersion ?? SERVER_VERSION,
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      pathCaseSensitive: fileProvider.capabilities.pathCaseSensitive,
      homeDir: homedir(),
      tmpDir: tmpdir(),
    }),
  }

  // The search services take an ILoggerService factory; funnel them into the
  // same logger so their diagnostics also land where the daemon logs.
  const loggerService: ILoggerService = {
    _serviceBrand: undefined,
    createLogger: () => log,
    setLevel: (level) => log.setLevel(level),
    getLevel: () => log.level,
  }
  const fileSearch = disposables.add(new FileSearchService(loggerService))
  const textSearch = disposables.add(new TextSearchService(loggerService))

  // Watcher tunnel: the local side reuses its WatcherProcessClient seq/ack
  // machinery unchanged, so this end forwards the raw message protocol and lets
  // its own WatcherProcessClient own the forked child + crash replay. Subscribes
  // use the remote client's id verbatim so events route back to the same watcher.
  const watcherEvents = new Emitter<WatcherHostResponse>()
  const watcherClient = disposables.add(
    new WatcherProcessClient(
      options?.watcherTransportFactory ?? createWatcherTransportFactory(log),
      loggerService,
    ),
  )
  disposables.add(watcherClient.onFileEvents((msg) => watcherEvents.fire(msg)))
  disposables.add(watcherClient.onWatchError((msg) => watcherEvents.fire(msg)))

  const watcherTunnel: IRemoteWatcherTunnel = {
    onMessage: watcherEvents.event,
    post: async (msg: WatcherHostRequest) => {
      try {
        if (msg.kind === 'subscribe') {
          await watcherClient.watch(msg.id, msg.dir, msg.ignore)
        } else {
          await watcherClient.unwatch(msg.id)
        }
        watcherEvents.fire({ kind: 'ack', seq: msg.seq })
      } catch (err) {
        watcherEvents.fire({
          kind: 'ack',
          seq: msg.seq,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
      }
    },
  }
  disposables.add({ dispose: () => watcherEvents.dispose() })

  server.registerChannel(RemoteChannels.Handshake, ProxyChannel.fromService(handshake))
  server.registerChannel(
    RemoteChannels.FileSystem,
    ProxyChannel.fromService(disposables.add(new RemoteFileStreamService(fileService, log))),
  )
  server.registerChannel(RemoteChannels.FileSearch, ProxyChannel.fromService(fileSearch))
  server.registerChannel(RemoteChannels.TextSearch, ProxyChannel.fromService(textSearch))
  server.registerChannel(RemoteChannels.FileWatcher, ProxyChannel.fromService(watcherTunnel))

  log.info(`[remote-server] channels assembled: ${Object.values(RemoteChannels).join(', ')}`)

  return disposables
}

function createWatcherTransportFactory(log: ILogger): WatcherTransportFactory {
  return () => {
    try {
      const entryPath = fileURLToPath(new URL('./watcherChild.js', import.meta.url))
      if (!existsSync(entryPath)) {
        throw new Error(`watcher child entry not found: ${entryPath}`)
      }
      return new ForkedWatcherTransport(entryPath, log)
    } catch (err) {
      log.warn(
        `[remote-server] watcher fork unavailable (${err instanceof Error ? err.message : String(err)}); falling back to in-process watcher`,
      )
      return createInMemoryWatcherTransport()
    }
  }
}
