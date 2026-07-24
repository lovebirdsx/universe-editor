/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the integrated terminal (the user-facing terminal panel),
 *  distinct from IAcpTerminalService (which serves ACP agents via polling and
 *  has no real PTY).
 *
 *  A single window-scoped service owns a pool of node-pty processes. All output
 *  is pushed live to the renderer via the `onData` Emitter/Event (not polled),
 *  keyed by terminalId so one channel multiplexes every terminal in the window.
 *  The renderer's xterm.js instances route `onData`/`onExit`/`onTitleChange` by
 *  `id` and call back `input`/`resize` on keystroke/layout changes.
 *
 *  Security: env is sanitized main-side (ELECTRON_RUN_AS_NODE / NODE_OPTIONS
 *  denylist, same set as the ACP host) before reaching node-pty.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'

/** Spawn-time spec. All fields optional; main fills sensible defaults. */
export interface ITerminalSpawnSpec {
  cwd?: string
  shell?: string
  args?: readonly string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  name?: string
}

/** Live output chunk for a single terminal. */
export interface ITerminalDataEvent {
  readonly id: string
  readonly data: string
}

// ---------------------------------------------------------------------------
// Terminal profiles (VSCode-style shell detection + user configuration)
// ---------------------------------------------------------------------------

/**
 * A single profile value as declared in `terminal.integrated.profiles.{os}`.
 * `null` removes the auto-detected profile of the same name. `path` may be an
 * array — it is a fallback chain, the first existing entry wins.
 */
export type ITerminalProfileConfigValue = {
  path?: string | readonly string[]
  args?: readonly string[]
  env?: Record<string, string>
} | null

/** A detected + config-merged profile with `path` resolved to a real executable. */
export interface ITerminalProfile {
  readonly profileName: string
  readonly path: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly isDefault: boolean
  readonly isAutoDetected: boolean
  /** Resolved by name lookup on PATH (UI may display just the basename). */
  readonly isFromPath?: boolean
}

export interface ITerminalProfilesRequest {
  /** Current value of `terminal.integrated.profiles.{windows|osx|linux}`. */
  readonly profiles?: Record<string, ITerminalProfileConfigValue>
  /** Current value of `terminal.integrated.defaultProfile.{os}`. */
  readonly defaultProfileName?: string
  /** Current value of `terminal.integrated.useWslProfiles` (Windows only). */
  readonly useWslProfiles?: boolean
}

/** Terminal process exit. */
export interface ITerminalExitEvent {
  readonly id: string
  readonly exitCode: number
  readonly signal?: number
}

/** OSC-driven title change (xterm forwards this; here it originates main-side). */
export interface ITerminalTitleEvent {
  readonly id: string
  readonly title: string
}

/** Snapshot describing a live terminal, returned from `create` / `list`. */
export interface ITerminalCreatedInfo {
  readonly id: string
  readonly pid: number
  readonly shell: string
  readonly name: string
}

/**
 * Window-scoped terminal pool. Lifecycle per id:
 *   create → (input | resize | kill)* → onExit → release
 * `kill` signals the process; `release` removes all state (and kills if alive).
 * `release` is named to avoid clashing with `Disposable.dispose()` on the impl.
 * Events carry `id` so a single channel serves every terminal in the window.
 */
export interface ITerminalService {
  readonly _serviceBrand: undefined

  readonly onData: Event<ITerminalDataEvent>
  readonly onExit: Event<ITerminalExitEvent>
  readonly onTitleChange: Event<ITerminalTitleEvent>

  create(spec: ITerminalSpawnSpec): Promise<ITerminalCreatedInfo>
  /**
   * Detect available shell profiles for the current platform (VSCode-style).
   * Detection config is passed in by the renderer (which owns settings);
   * detection itself runs main-side where the filesystem is reachable.
   */
  getProfiles(request: ITerminalProfilesRequest): Promise<readonly ITerminalProfile[]>
  input(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  kill(id: string): Promise<void>
  list(): Promise<readonly ITerminalCreatedInfo[]>
  release(id: string): Promise<void>
}

export const ITerminalService = createDecorator<ITerminalService>('terminalService')
