/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IHostService (workbench/services/host/browser/host.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { URI, UriComponents } from '../base/uri.js'

export type HostPlatform = 'win32' | 'darwin' | 'linux' | 'unknown'

/** Known external terminal binaries (Windows only — other platforms use the system default). */
export type ExternalTerminalKind = 'wt' | 'cmd' | 'powershell' | 'pwsh'

const KNOWN_PLATFORMS = new Set<HostPlatform>(['win32', 'darwin', 'linux'])

/** Coerce a raw `process.platform`-shaped string into our known set. */
export function normalizePlatform(raw: string | undefined): HostPlatform {
  if (raw && (KNOWN_PLATFORMS as Set<string>).has(raw)) {
    return raw as HostPlatform
  }
  return 'unknown'
}

/**
 * Abstraction over the host process / OS window. Implementations live on the
 * main side; the renderer consumes a `ProxyChannel.toService<IHostService>(...)`
 * proxy directly (no wrapper class). The `platform` constant is served locally
 * via the proxy's `properties` option since it is a sync bootstrap value.
 */
export interface IHostService {
  readonly _serviceBrand: undefined

  /** OS family the renderer is running on. Stable for the lifetime of the session. */
  readonly platform: HostPlatform

  /** Fires when the host window's maximized state changes. */
  readonly onDidChangeMaximized: Event<boolean>

  isMaximized(): Promise<boolean>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  restart(): Promise<void>
  toggleDevTools(): Promise<void>

  /**
   * Request the host to open a new application window. The new window
   * inherits the current workspace context.
   */
  openNewWindow(): Promise<void>

  /**
   * Show the given file path in the OS file manager (Explorer / Finder / Files)
   * with the item selected. The path must be an absolute fs path.
   */
  showItemInFolder(fsPath: string): Promise<void>

  /**
   * OS file picker. Returns the chosen file's URI, or null if the user
   * cancelled. Implementations use the native dialog tied to the focused
   * BrowserWindow.
   */
  showOpenFileDialog(opts?: IShowOpenFileOptions): Promise<URI | UriComponents | null>

  /**
   * OS save-as picker. Returns the chosen file's URI, or null if the user
   * cancelled.
   */
  showSaveFileDialog(opts?: IShowSaveFileOptions): Promise<URI | UriComponents | null>

  /**
   * Open the file at `path` with the OS default application.
   * Returns an error string on failure, or empty string on success.
   */
  openWithDefaultApp(path: string): Promise<string>

  /** Open the user-data directory (settings, keybindings, state) in the OS file manager. */
  openUserDataFolder(): Promise<void>

  /**
   * Launch VS Code (`code` on PATH) with `fsPath` as the folder/file to open.
   * Returns an error string on failure (e.g. `code` not found), or empty string
   * on success.
   */
  openInVSCode(fsPath: string): Promise<string>

  /**
   * Open the OS external terminal with `cwd` as its working directory.
   * On Windows, `kind` selects the terminal binary (defaults to 'wt' if omitted).
   * On macOS / Linux, `kind` is ignored — the system default terminal is used.
   */
  openTerminal(cwd: string, kind?: ExternalTerminalKind): Promise<void>

  /**
   * Show an OS-level desktop notification. By default it is suppressed while the
   * window is focused (`onlyWhenBlurred`), so callers can fire it unconditionally
   * and rely on the host to avoid interrupting an active user. The returned
   * promise settles when the user clicks the notification or it is dismissed.
   */
  notify(opts: ISystemNotificationOptions): Promise<ISystemNotificationResult>

  /** Bring the window to the foreground (restoring it from minimized if needed). */
  focusWindow(): Promise<void>

  /** Application and runtime version info, for the About dialog. */
  getVersionInfo(): Promise<IVersionInfo>
}

export interface IVersionInfo {
  readonly productName: string
  readonly version: string
  readonly electron: string
  readonly node: string
  readonly chromium: string
  readonly v8: string
}

export interface ISystemNotificationOptions {
  readonly title: string
  readonly body: string
  /** Only show while the window is blurred (default true). */
  readonly onlyWhenBlurred?: boolean
  /** Optional PNG data URL rendered as the notification icon. */
  readonly icon?: string
}

export interface ISystemNotificationResult {
  /** Whether the notification was actually shown (false if gated by focus / unsupported). */
  readonly shown: boolean
  /** Whether the user clicked the notification body. */
  readonly clicked: boolean
}

export interface IShowOpenFileOptions {
  readonly defaultPath?: string
  readonly title?: string
}

export interface IShowSaveFileOptions {
  readonly defaultPath?: string
  readonly title?: string
}

export const IHostService = createDecorator<IHostService>('hostService')

/**
 * The wire-only subset of `IHostService` that crosses the process boundary.
 * `platform` is excluded because it is supplied locally via `properties`.
 */
export type IHostServiceWire = Omit<IHostService, 'platform'>
