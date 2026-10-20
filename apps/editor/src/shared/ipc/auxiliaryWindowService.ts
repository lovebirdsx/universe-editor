/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the auxiliary editor window service. The service is registered on
 *  the PARENT window's channel only: every call is implicitly scoped to that parent, and
 *  a token from another parent is rejected. The renderer never sends a BrowserWindow id.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

/**
 * Marker exposed by the dedicated auxiliary preload. The parent renderer can read it on
 * the synchronously returned child Window to confirm the minimal preload ran and that the
 * full main preload (with its IPC bridge) was not inherited.
 *
 * Keep in sync with `src/preload/auxiliary.ts` (the preload deliberately does not import
 * this module, to stay a zero-dependency entry).
 */
export const AUXILIARY_WINDOW_MARKER_KEY = '__universeAuxiliaryWindow'

export interface AuxiliaryWindowBounds {
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
}

/** Persistable geometry returned in state/change events and accepted back by prepareOpen. */
export interface AuxiliaryWindowGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly isMaximized: boolean
  readonly isFullscreen: boolean
  readonly displayId: number
  readonly displayBounds?: { x: number; y: number; width: number; height: number }
}

export interface AuxiliaryWindowOpenOptions {
  /**
   * Geometry to restore. Values are clamped into a display work area (reusing the
   * window-state validator), so a saved position on a now-unplugged monitor cannot
   * strand the new window off-screen.
   */
  readonly geometry?: AuxiliaryWindowBounds & {
    readonly isMaximized?: boolean
    readonly isFullscreen?: boolean
    readonly displayId?: number
    readonly displayBounds?: { x: number; y: number; width: number; height: number }
  }
  readonly title?: string
  readonly backgroundColor?: string
}

export interface PreparedAuxiliaryWindow {
  /**
   * One-time, parent-bound capability. Pass it as `window.open(..., frameName)`'s name.
   * It is consumed by the first created window and must never be persisted.
   */
  readonly token: string
  /** Alias of `token`; what the renderer passes as the window name. */
  readonly frameName: string
}

export interface AuxiliaryWindowState {
  readonly token: string
  readonly title: string
  readonly geometry: AuxiliaryWindowGeometry
  readonly isFocused: boolean
  readonly isVisible: boolean
}

export interface AuxiliaryWindowCloseRequest {
  readonly token: string
}

export interface AuxiliaryWindowClosedEvent {
  readonly token: string
}

/**
 * Parent-renderer view of the auxiliary windows it owns. Implementations in main are
 * created per parent BrowserWindow, so ownership is structural rather than a parameter
 * the renderer could forge.
 */
export interface IAuxiliaryWindowsService {
  readonly _serviceBrand: undefined

  readonly onDidCreateWindow: Event<AuxiliaryWindowState>
  readonly onDidCloseWindow: Event<AuxiliaryWindowClosedEvent>
  /**
   * Fired when the OS/user asks to close an auxiliary window. The close is already
   * vetoed; the parent renderer must migrate protected editors and then call
   * `finalizeClose(token)`. Closing the parent window skips this round-trip.
   */
  readonly onDidRequestClose: Event<AuxiliaryWindowCloseRequest>
  /** Focus/blur and debounced geometry changes; use it to persist layout. */
  readonly onDidChangeWindowState: Event<AuxiliaryWindowState>

  /** Reserve a one-time token; then call `window.open('about:blank', frameName)`. */
  prepareOpen(options?: AuxiliaryWindowOpenOptions): Promise<PreparedAuxiliaryWindow>
  /** Drop a reservation that will never be turned into a window. */
  cancelPrepared(token: string): Promise<void>

  getWindows(): Promise<readonly AuxiliaryWindowState[]>
  getWindowState(token: string): Promise<AuxiliaryWindowState | null>
  focusWindow(token: string): Promise<void>
  minimizeWindow(token: string): Promise<void>
  toggleMaximizeWindow(token: string): Promise<void>

  /** Start the close flow (`win.close()`), which is vetoed and reported via the event. */
  requestClose(token: string): Promise<void>
  /** Destroy without another veto round-trip, after protected editors were moved out. */
  finalizeClose(token: string): Promise<void>

  zoomIn(token: string): Promise<void>
  zoomOut(token: string): Promise<void>
  /** Reset the auxiliary window to 100% (Chromium zoom level 0). */
  resetZoom(token: string): Promise<void>
}

export const IAuxiliaryWindowsService =
  createDecorator<IAuxiliaryWindowsService>('auxiliaryWindowsService')
