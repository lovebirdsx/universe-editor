/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the auto-update service (VSCode-style). The main
 *  process wraps electron-updater, owns the scheduling, and drives a discriminated
 *  -union state machine; the renderer reflects it in the title-bar indicator +
 *  notifications. Every state carries its own payload so the UI can render without
 *  extra queries; `explicit` distinguishes a user-initiated check from a background
 *  one; `idle` carries one-shot `error` / `notAvailable` flags that are cleared the
 *  moment after they are broadcast (so a freshly-opened window never reads a stale
 *  "no update" / error prompt). `urgency` rides along on the update-bearing states so
 *  the UI can shout about an important fix without asking main again.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type UpdateStateType =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'

/** Why auto-update is disabled — mirrors the `update.mode` semantics. */
export type UpdateDisabledReason = 'manual' | 'none' | 'not-supported'

/**
 * How urgently a found update should reach the user. Comes from the release note's
 * `urgency` frontmatter field via the feed's `notes/index.json`; anything the client
 * cannot resolve (offline, 404, older feed) stays `normal`.
 */
export type UpdateUrgency = 'normal' | 'important'

interface UpdateStateBase {
  /** App version currently running (`getAppVersion()`). Present on every state. */
  readonly currentVersion: string
}

export interface IdleUpdateState extends UpdateStateBase {
  readonly type: 'idle'
  /** Set once when the last check failed. Cleared right after it is broadcast. */
  readonly error?: string
  /** Set once when the last check found nothing. Cleared right after broadcast. */
  readonly notAvailable?: boolean
  /** Whether the settled check (error / notAvailable) was user-initiated. */
  readonly explicit?: boolean
}

export interface DisabledUpdateState extends UpdateStateBase {
  readonly type: 'disabled'
  readonly reason: UpdateDisabledReason
}

export interface CheckingUpdateState extends UpdateStateBase {
  readonly type: 'checking'
  readonly explicit: boolean
}

export interface AvailableUpdateState extends UpdateStateBase {
  readonly type: 'available'
  readonly version: string
  readonly explicit: boolean
  readonly urgency?: UpdateUrgency
  /** Main is already downloading this — the UI must not offer a "Download" action. */
  readonly autoDownload?: boolean
}

export interface DownloadingUpdateState extends UpdateStateBase {
  readonly type: 'downloading'
  readonly version: string
  /** Download progress 0–100. */
  readonly percent: number
  readonly urgency?: UpdateUrgency
}

export interface DownloadedUpdateState extends UpdateStateBase {
  readonly type: 'downloaded'
  readonly version: string
  readonly urgency?: UpdateUrgency
}

export type UpdateState =
  | IdleUpdateState
  | DisabledUpdateState
  | CheckingUpdateState
  | AvailableUpdateState
  | DownloadingUpdateState
  | DownloadedUpdateState

export interface IUpdateService {
  readonly _serviceBrand: undefined
  readonly onDidChangeState: Event<UpdateState>
  getState(): Promise<UpdateState>
  /**
   * Query the configured feed for a newer version. `explicit` marks a user-
   * initiated check (surfaces "up to date" / failure results); a background check
   * stays quiet unless a new version is found. Resolves once the check settles.
   */
  checkForUpdates(explicit: boolean): Promise<void>
  /** Download the available update. No-op unless state is `available`. */
  downloadUpdate(): Promise<void>
  /** Quit and install a downloaded update. No-op unless state is `downloaded`. */
  quitAndInstall(): Promise<void>
}

export const IUpdateService = createDecorator<IUpdateService>('updateService')
