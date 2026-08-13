/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for surfacing remote-connection state to the renderer.
 *  The main-side owner is RemoteConnectionMainService (an internal state machine);
 *  this service is a thin, serializable facade over it so the renderer (and the
 *  E2E probe) can read per-authority connection state, drive retry/close/stop, and
 *  — under E2E only — drop a socket to exercise transparent reconnection. State is
 *  a string-union DTO: the main-internal type is never leaked into shared.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type RemoteConnectionStateDto =
  | 'idle'
  | 'deploying'
  | 'forwarding'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disposed'

export interface RemoteConnectionStatusDto {
  readonly authority: string
  readonly state: RemoteConnectionStateDto
  readonly errorMessage?: string
}

/**
 * Serialisable snapshot of a remote host's environment, surfaced to the renderer
 * once a connection has been established. Server-native paths (homeDir/tmpDir)
 * stay untransformed here — they are host descriptions, not resources.
 */
export interface RemoteEnvironmentDto {
  readonly os: string
  readonly arch: string
  readonly homeDir: string
  readonly tmpDir: string
  readonly pathCaseSensitive: boolean
  readonly serverVersion: string
}

export interface IRemoteStatusService {
  readonly _serviceBrand: undefined
  /** Latest known per-authority state, keyed by authorities seen so far. */
  getConnections(): Promise<readonly RemoteConnectionStatusDto[]>
  /** Trigger a full bring-up for `authority` and resolve with its environment. */
  connect(authority: string): Promise<RemoteEnvironmentDto>
  /** Environment for an already-connected authority; null when not connected. */
  getEnvironment(authority: string): Promise<RemoteEnvironmentDto | null>
  /** Host names from the local `~/.ssh/config` (wildcard patterns excluded). */
  listSshHosts(): Promise<string[]>
  retryConnection(authority: string): Promise<void>
  closeConnection(authority: string): Promise<void>
  stopServer(authority: string): Promise<void>
  readonly onDidChangeState: Event<RemoteConnectionStatusDto>
  /** Only available under UNIVERSE_E2E=1; throws otherwise. */
  dropSocketForTesting(authority: string): Promise<void>
}

export const IRemoteStatusService = createDecorator<IRemoteStatusService>('remoteStatusService')
