/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the auto-update service. The main process wraps
 *  electron-updater and drives a small state machine; the renderer reflects it
 *  in the status bar + notifications (VSCode-style prompt-to-update flow).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  readonly status: UpdateStatus
  /** App version currently running (`app.getVersion()`). */
  readonly currentVersion: string
  /** Target version — present for `available` / `downloading` / `downloaded`. */
  readonly version?: string
  /** Download progress 0–100 — present for `downloading`. */
  readonly percent?: number
  /** Human-readable message — present for `error`. */
  readonly error?: string
}

export interface IUpdateService {
  readonly _serviceBrand: undefined
  readonly onDidChangeState: Event<UpdateState>
  getState(): Promise<UpdateState>
  /** Query the configured feed for a newer version. Resolves once the check settles. */
  checkForUpdates(): Promise<void>
  /** Download the available update. No-op unless state is `available`. */
  downloadUpdate(): Promise<void>
  /** Quit and install a downloaded update. No-op unless state is `downloaded`. */
  quitAndInstall(): Promise<void>
}

export const IUpdateService = createDecorator<IUpdateService>('updateService')
