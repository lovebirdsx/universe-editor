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
  readonly progress?: RemoteConnectionProgressDto
}

export type RemoteConnectionProgressStepDto =
  | 'stopping-old'
  | 'uploading'
  | 'installing'
  | 'installing-node'
  | 'starting-daemon'

export interface RemoteConnectionProgressDto {
  readonly stepId: RemoteConnectionProgressStepDto
  readonly stepIndex: number
  readonly stepTotal: number
  readonly startedAt: number
}

export const REMOTE_CONNECTION_LOG_CHANNEL_NAME = 'Remote Connection'

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

/**
 * A locally-detected WSL distro, offered as a `wsl+<name>` connect target.
 * `isRunning` comes from `wsl --list --running` — a stopped distro is still
 * connectable (wsl.exe boots it on demand), the flag is display-only.
 */
export interface WslDistroDto {
  readonly name: string
  readonly isDefault: boolean
  readonly isRunning: boolean
  readonly version: number
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
  /** Locally-detected WSL distros; [] on non-Windows or when WSL is absent. */
  listWslDistros(): Promise<readonly WslDistroDto[]>
  retryConnection(authority: string): Promise<void>
  closeConnection(authority: string): Promise<void>
  /**
   * Close every window scoped to `authority` (each runs its shutdown veto
   * chain, e.g. the running-session guard), then disconnect the connection so
   * it does not auto-reconnect. Resolves false when a veto cancelled the whole
   * action — the connection stays up then. When closing would leave no window,
   * main opens a fresh local empty window first.
   */
  closeRemoteWorkspace(authority: string): Promise<boolean>
  /**
   * Close every window scoped to `authority` (each runs its shutdown veto
   * chain, e.g. the running-session guard), then stop the remote server.
   * Resolves false when a veto cancelled the whole action — the server keeps
   * running then. When closing would leave no window, main opens a fresh local
   * empty window first.
   */
  stopServer(authority: string): Promise<boolean>
  readonly onDidChangeState: Event<RemoteConnectionStatusDto>
  /** Only available under UNIVERSE_E2E=1; throws otherwise. */
  dropSocketForTesting(authority: string): Promise<void>
  /** Drop the extension-host tunnel socket for `authority` (E2E only). */
  dropExtensionHostSocketForTesting(authority: string): Promise<void>
}

export const IRemoteStatusService = createDecorator<IRemoteStatusService>('remoteStatusService')
