/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract between the local editor (main process) and a remote
 *  universe-editor-server daemon reached over an ssh-forwarded TCP port. Both
 *  ends depend on platform, so this is the single source of truth for the
 *  protocol version, connection types, handshake DTOs and channel names.
 *
 *  URI convention (v2): the client sends `remote-ssh://<authority>/<path>` URIs
 *  UNTRANSLATED. The server applies a per-connection URITransformer inside its
 *  IPC codec (remote-ssh → file on decode, file → remote-ssh on encode), so
 *  server services still operate as a headless local file-service stack while
 *  the client never performs manual translation. Consequently every path in a
 *  channel DTO MUST be a URI (UriComponents with $mid) — bare string paths do
 *  not get transformed. Documented exception: watcher event paths are server
 *  fsPath strings by design; the client maps them via `remoteFsPathToUri`.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { URI } from '../base/uri.js'
import type { IFileService } from '../files/fileService.js'
import type { WatcherHostRequest, WatcherHostResponse } from '../files/watcherProtocol.js'

/** Bumped on any incompatible change to the framing, handshake or DTOs below. */
export const REMOTE_PROTOCOL_VERSION = 2

/** Scheme of remote workspace resources: `remote-ssh://<authority>/<path>`. */
export const REMOTE_SCHEME = 'remote-ssh'

/**
 * One TCP connection per type, both through the same forwarded port. Management
 * carries the channel layer (fs / search / watcher / terminal / acp / config);
 * ExtensionHost is a raw byte pipe to a forked extension host (frames pumped
 * verbatim, the daemon never decodes them).
 */
export enum RemoteConnectionType {
  Management = 1,
  ExtensionHost = 2,
}

export const RemoteChannels = {
  Handshake: 'handshake',
  FileSystem: 'fileSystem',
  FileSearch: 'fileSearch',
  TextSearch: 'textSearch',
  FileWatcher: 'fileWatcher',
  Terminal: 'terminal',
  AcpHost: 'acpHost',
  AgentConfig: 'agentConfig',
} as const

export type RemoteChannelName = (typeof RemoteChannels)[keyof typeof RemoteChannels]

// -------- Connection handshake (PersistentProtocol Control frames, JSON) --------

/**
 * First (and only) client → server control frame after the socket opens, for
 * both fresh connects and reconnects. The server validates token + version,
 * then either creates a new protocol owner or re-attaches the socket to the
 * grace-period-held connection identified by `reconnectionToken`.
 */
export interface IRemoteConnectionRequest {
  readonly type: 'connect'
  readonly protocolVersion: number
  /** Connection token from the daemon's server.json — transport auth. */
  readonly token: string
  readonly connectionType: RemoteConnectionType
  /** The `remote-ssh` authority this client addresses the daemon as. Drives the server-side URI transformer. */
  readonly authority: string
  /** Client-generated UUID identifying this logical connection across socket swaps. */
  readonly reconnectionToken: string
  readonly isReconnection: boolean
}

export enum RemoteConnectionErrorCode {
  InvalidToken = 'invalidToken',
  VersionMismatch = 'versionMismatch',
  UnknownReconnectionToken = 'unknownReconnectionToken',
  /** A fresh connect reused a reconnectionToken that is still alive. */
  DuplicateReconnectionToken = 'duplicateReconnectionToken',
  Unknown = 'unknown',
}

export type IRemoteConnectionResponse =
  | { readonly type: 'ok' }
  | { readonly type: 'error'; readonly code: RemoteConnectionErrorCode; readonly message: string }

// -------- Environment (Handshake channel, after connect) --------

/**
 * Static facts about the server host, fetched once per connection via the
 * Handshake channel. Paths are server-native strings (POSIX on the supported
 * remote targets) — they are host descriptions, not resources, so they stay
 * untransformed by design.
 */
export interface IRemoteEnvironment {
  readonly protocolVersion: number
  readonly serverVersion: string
  /** `process.platform` of the server host. */
  readonly os: string
  readonly arch: string
  readonly nodeVersion: string
  readonly pathCaseSensitive: boolean
  readonly homeDir: string
  readonly tmpDir: string
}

export interface IRemoteHandshakeService {
  getInfo(): Promise<IRemoteEnvironment>
}

// -------- Daemon bookkeeping --------

/**
 * Contents of `~/.universe-editor-server/<version>/server.json`, written
 * atomically by `serve` and printed by `check`/`start` for the client to parse.
 * The daemon listens on 127.0.0.1 only; the client reaches it via ssh -L.
 */
export interface IRemoteDaemonInfo {
  readonly serverVersion: string
  readonly protocolVersion: number
  readonly port: number
  readonly token: string
  readonly pid: number
}

// -------- Watcher tunnel --------

/**
 * Watcher tunnel: mirrors the WatcherHost message protocol over a channel.
 * Requests resolve when the server accepted the message (acks still arrive via
 * `onMessage`), which lets the local WatcherProcessClient reuse its seq/ack and
 * desired/replay machinery unchanged. Event paths inside `WatcherHostResponse`
 * are server fsPath strings — the documented string-path exception.
 */
export interface IRemoteWatcherTunnel {
  readonly onMessage: Event<WatcherHostResponse>
  post(msg: WatcherHostRequest): Promise<void>
}

// -------- File stream tunnel --------

/**
 * One multiplexed frame of a streaming file read: a data chunk, the terminal
 * `done`, or an `error`. `seq` is a per-stream monotonic counter (0-indexed data
 * chunks, then one final frame for done/error) so a consumer can detect a gap
 * defensively even though PersistentProtocol delivers in order.
 */
export interface IRemoteFileStreamEvent {
  readonly streamId: number
  readonly seq: number
  readonly data?: Uint8Array
  readonly done?: boolean
  readonly error?: { readonly message: string; readonly code?: string }
}

/**
 * The remote FileSystem channel surface: the generic IFileService plus a
 * multiplexed streaming reader. Large reads are pushed as 256KB chunks through
 * `onReadStreamData` with windowed flow control (up to 16 unacknowledged chunks
 * in flight, advanced by `ackReadStream`) instead of one response frame, so a
 * multi-MB file never head-of-line blocks every other channel message.
 */
export interface IRemoteFileStreamService extends IFileService {
  startReadStream(resource: URI): Promise<{ readonly streamId: number; readonly size: number }>
  ackReadStream(streamId: number, receivedSeq: number): Promise<void>
  cancelReadStream(streamId: number): Promise<void>
  readonly onReadStreamData: Event<IRemoteFileStreamEvent>
}
