/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure decisions for the tray-backed background mode. Kept free of Electron so
 *  every branch is unit-testable; the main service supplies live state.
 *--------------------------------------------------------------------------------------------*/

/** Idle budget before a hidden window with no work is closed for real. */
export const BACKGROUND_IDLE_RECLAIM_MS = 10 * 60_000
/** How often hidden windows are examined against {@link BACKGROUND_IDLE_RECLAIM_MS}. */
export const BACKGROUND_IDLE_SCAN_INTERVAL_MS = 30_000

export interface SupportsLoginItemOptions {
  readonly isPackaged: boolean
  /** Normally process.platform; injectable for tests. */
  readonly platform: NodeJS.Platform
  readonly e2e: boolean
}

/** OS login items exist only in installed Windows/macOS builds, and never under E2E. */
export function supportsLoginItem({
  isPackaged,
  platform,
  e2e,
}: SupportsLoginItemOptions): boolean {
  return isPackaged && !e2e && (platform === 'win32' || platform === 'darwin')
}

export interface BackgroundModeActiveInput {
  /** Environment overrides count: `UNIVERSE_MOBILE_GATEWAY=1` enables the gateway. */
  readonly gatewayEnabled: boolean
  readonly keepRunningInBackground: boolean
}

/** The feature is only meaningful when the phone gateway is actually on. */
export function isBackgroundModeActive({
  gatewayEnabled,
  keepRunningInBackground,
}: BackgroundModeActiveInput): boolean {
  return gatewayEnabled && keepRunningInBackground
}

export interface HiddenWindowInfo {
  readonly id: number
  readonly hiddenSeq: number
}

export type PrimaryWindowAction =
  | { readonly kind: 'show-hidden'; readonly windowId: number }
  | { readonly kind: 'restore' }
  | { readonly kind: 'create' }

export interface PrimaryWindowActionInput {
  readonly hidden: readonly HiddenWindowInfo[]
  readonly liveWindowCount: number
}

/**
 * What "show/open" from the tray should do: bring back the most recently hidden
 * window first (the one the user just closed), else restore the persisted
 * session when no window exists at all, else open a fresh empty window.
 */
export function decidePrimaryWindowAction({
  hidden,
  liveWindowCount,
}: PrimaryWindowActionInput): PrimaryWindowAction {
  const latest = latestHidden(hidden)
  if (latest !== undefined) return { kind: 'show-hidden', windowId: latest.id }
  if (liveWindowCount === 0) return { kind: 'restore' }
  return { kind: 'create' }
}

export interface ActivateActionInput {
  readonly hidden: readonly HiddenWindowInfo[]
  readonly liveWindowCount: number
}

export type ActivateAction =
  | { readonly kind: 'show-hidden'; readonly windowId: number }
  | { readonly kind: 'restore' }
  | { readonly kind: 'focus' }

/**
 * App activation (dock/icon click) must never create a window when one is
 * already visible; otherwise prefer a hidden window, then the saved session.
 */
export function decideActivateAction({
  hidden,
  liveWindowCount,
}: ActivateActionInput): ActivateAction {
  if (liveWindowCount - hidden.length > 0) return { kind: 'focus' }
  const latest = latestHidden(hidden)
  if (latest !== undefined) return { kind: 'show-hidden', windowId: latest.id }
  return { kind: 'restore' }
}

function latestHidden(hidden: readonly HiddenWindowInfo[]): HiddenWindowInfo | undefined {
  let latest: HiddenWindowInfo | undefined
  for (const info of hidden) {
    if (latest === undefined || info.hiddenSeq > latest.hiddenSeq) latest = info
  }
  return latest
}

export interface SessionPersistCandidate<T> {
  readonly entry: T
  readonly hidden: boolean
  readonly hiddenSeq: number
}

/**
 * Which windows the multi-window session remembers. Visible windows always win;
 * when every window is hidden keep only the most recently hidden one — the same
 * "closing the last window keeps it for restore" behavior, without restoring a
 * backlog of windows the user explicitly closed to the tray.
 */
export function planSessionPersist<T>(entries: readonly SessionPersistCandidate<T>[]): T[] {
  const visible: T[] = []
  for (const candidate of entries) {
    if (!candidate.hidden) visible.push(candidate.entry)
  }
  if (visible.length > 0) return visible
  if (entries.length === 0) return []
  let latest = entries[0]!
  for (const candidate of entries) {
    if (candidate.hiddenSeq > latest.hiddenSeq) latest = candidate
  }
  return [latest.entry]
}
