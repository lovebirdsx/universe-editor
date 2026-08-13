/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract between the local editor (main process) and a remote
 *  universe-editor-server spawned over ssh (or any stdio transport). Both ends
 *  depend on platform, so this is the single source of truth for channel names,
 *  the protocol version and the handshake DTO. The server never sees the
 *  `remote-ssh` scheme: the local side translates remote URIs to `file:` URIs at
 *  the tunnel boundary and back, so the server operates as a headless local
 *  file-service stack.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { WatcherHostRequest, WatcherHostResponse } from '../files/watcherProtocol.js'

/** Bumped on any incompatible change to the channels or DTOs below. */
export const REMOTE_PROTOCOL_VERSION = 1

/** Scheme of remote workspace resources: `remote-ssh://<authority>/<path>`. */
export const REMOTE_SCHEME = 'remote-ssh'

export const RemoteChannels = {
  Handshake: 'handshake',
  FileSystem: 'fileSystem',
  FileSearch: 'fileSearch',
  TextSearch: 'textSearch',
  FileWatcher: 'fileWatcher',
} as const

export type RemoteChannelName = (typeof RemoteChannels)[keyof typeof RemoteChannels]

export interface IRemoteHandshakeInfo {
  readonly protocolVersion: number
  /** `process.platform` of the server host. */
  readonly os: string
  readonly arch: string
  readonly pathCaseSensitive: boolean
}

/** First call after connecting; a version mismatch must kill the connection. */
export interface IRemoteHandshakeService {
  getInfo(): Promise<IRemoteHandshakeInfo>
}

/**
 * Watcher tunnel: mirrors the WatcherHost message protocol over a channel.
 * Requests resolve when the server accepted the message (acks still arrive via
 * `onMessage`), which lets the local WatcherProcessClient reuse its seq/ack and
 * desired/replay machinery unchanged.
 */
export interface IRemoteWatcherTunnel {
  readonly onMessage: Event<WatcherHostResponse>
  post(msg: WatcherHostRequest): Promise<void>
}
