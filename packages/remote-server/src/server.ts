/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote server assembly: registers the five remote channels on an IChannelServer.
 *  The process entry (bootstrap.ts) wires stdio/protocol/lifecycle; this module only
 *  builds services and registers channels so tests can drive a full server over an
 *  in-memory protocol. Everything here is a headless local file-service stack — the
 *  server never sees a non-`file:` URI (the local side translates remote-ssh URIs at
 *  the tunnel boundary).
 *--------------------------------------------------------------------------------------------*/

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
  type WatcherHostResponse,
} from '@universe-editor/platform'
import {
  FileSearchService,
  NodeFileSystemProvider,
  TextSearchService,
  WatcherHost,
} from '@universe-editor/node-services'

export function createRemoteServer(server: IChannelServer, logger?: ILogger): IDisposable {
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
      os: process.platform,
      arch: process.arch,
      pathCaseSensitive: fileProvider.capabilities.pathCaseSensitive,
    }),
  }

  // The search services take an ILoggerService factory; funnel them into the
  // same logger so their diagnostics also land on stderr.
  const loggerService: ILoggerService = {
    _serviceBrand: undefined,
    createLogger: () => log,
    setLevel: (level) => log.setLevel(level),
    getLevel: () => log.level,
  }
  const fileSearch = disposables.add(new FileSearchService(loggerService))
  const textSearch = disposables.add(new TextSearchService(loggerService))

  // Watcher tunnel: the local side reuses its WatcherProcessClient seq/ack
  // machinery unchanged, so this is just a WatcherHost behind a message event.
  const watcherEmitter = new Emitter<WatcherHostResponse>()
  const watcherHost = new WatcherHost((msg) => watcherEmitter.fire(msg))
  const watcherTunnel: IRemoteWatcherTunnel = {
    onMessage: watcherEmitter.event,
    post: (msg) => watcherHost.handle(msg),
  }
  disposables.add({
    dispose: () => {
      void watcherHost.dispose()
      watcherEmitter.dispose()
    },
  })

  server.registerChannel(RemoteChannels.Handshake, ProxyChannel.fromService(handshake))
  server.registerChannel(RemoteChannels.FileSystem, ProxyChannel.fromService(fileService))
  server.registerChannel(RemoteChannels.FileSearch, ProxyChannel.fromService(fileSearch))
  server.registerChannel(RemoteChannels.TextSearch, ProxyChannel.fromService(textSearch))
  server.registerChannel(RemoteChannels.FileWatcher, ProxyChannel.fromService(watcherTunnel))

  log.info(`[remote-server] channels assembled: ${Object.values(RemoteChannels).join(', ')}`)

  return disposables
}
