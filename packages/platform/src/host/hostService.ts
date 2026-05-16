/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IHostService (workbench/services/host/browser/host.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { URI, UriComponents } from '../base/uri.js'

export type HostPlatform = 'win32' | 'darwin' | 'linux' | 'unknown'

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
  toggleDevTools(): Promise<void>

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
