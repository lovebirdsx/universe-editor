/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IHistoryService — bounded back/forward navigation history across editor inputs.
 *
 *  Each editor entry captures a (resource, selection) tuple; goBack/goForward
 *  emit the desired target without mutating editor state directly. Renderer
 *  wires the emissions to openEditor + restoreViewState. In-memory only;
 *  mirrors vscode.
 *
 *  With Vim mode on, the renderer also records *view* entries (the Explorer,
 *  Search, a panel view, ...) so Ctrl+O / Ctrl+I walk editor positions and
 *  view focus as one jump list.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { URI } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

export interface IHistorySelection {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/** An editor position. `kind` is optional so recorders can omit it. */
export interface IHistoryEntry {
  readonly kind?: 'editor'
  readonly resource: URI
  readonly selection?: IHistorySelection | undefined
  /**
   * Editor input typeId, set by recorders when the entry corresponds to a
   * non-text editor (Settings, Welcome, Agent session, ...). Used by GoBack/GoForward
   * to recreate the input via `EditorRegistry.deserialize(typeId, serialized)`
   * when no live instance is found in any group.
   */
  readonly typeId?: string
  /** Serialized payload from `EditorInput.serialize?.()` — paired with `typeId`. */
  readonly serialized?: unknown
  readonly timestamp: number
}

/** A focused view (Vim mode only): navigating to it focuses the view. */
export interface IHistoryViewEntry {
  readonly kind: 'view'
  readonly viewId: string
  readonly timestamp: number
}

export type IHistoryStackEntry = IHistoryEntry | IHistoryViewEntry

export interface IHistoryNavigateOptions {
  /** Vim's `3<C-o>`: land `count` entries away (stops at the oldest / newest). */
  readonly count?: number | undefined
  /**
   * Entries that can no longer be navigated to (a view that was removed or is
   * hidden by its `when`). They are dropped from both stacks while stepping
   * and do not consume `count`.
   */
  readonly isStale?: ((entry: IHistoryStackEntry) => boolean) | undefined
}

export interface IHistoryService {
  readonly _serviceBrand: undefined

  readonly onDidChange: Event<void>

  /**
   * Fires synchronously at the very start of goBack/goForward — before the
   * stack is inspected or mutated. Listeners use this to flush a pending
   * debounced cursor record into the stack first: a significant move still
   * sitting in the debounce window would otherwise be popped off as the
   * "current" entry and permanently lost (the real current position ends up in
   * neither stack). Firing before the depth check lets such a flush even turn
   * an about-to-fail goBack into a valid one.
   */
  readonly onWillNavigate: Event<void>

  /** Record `entry` as the latest navigation point. Drops the forward stack. */
  record(entry: Omit<IHistoryEntry, 'timestamp'>): void

  /**
   * Update the selection of the most recent back-stack entry for `resource`
   * in place, without changing stack order or touching the forward stack.
   * Used to capture a leaving editor's final caret when switching away (the
   * move was too small to record on its own). No-op if `resource` has no entry.
   */
  updateCurrent(resource: URI, selection: IHistorySelection): void

  /**
   * Record that `viewId` now holds focus. A no-op when it already is the top
   * entry (so landing on it via goForward keeps the forward stack); otherwise
   * an older entry for the same view is removed first (one entry per view, like
   * Vim's jumplist) and the forward stack is dropped.
   */
  recordView(viewId: string): void

  /** Drop every view entry from both stacks (Vim mode turned off). */
  removeViewEntries(): void

  /**
   * Step back (`count` entries, default 1). Fires onWillNavigate once. Returns
   * the entry to navigate to, or undefined — in which case neither stack
   * changed.
   */
  goBack(options?: IHistoryNavigateOptions): IHistoryStackEntry | undefined

  /** Step forward; same contract as goBack. */
  goForward(options?: IHistoryNavigateOptions): IHistoryStackEntry | undefined

  /**
   * Called by the navigation action once its reveal of `resource` completes.
   * Extends that resource's record-suppression deadline to now + 350ms: the
   * reveal takes variable time (editor mount, selection restore) and the
   * cursor listener debounces another 250ms on top, so without this a slow
   * reveal escapes the original suppression window and its trailing flush
   * clears the freshly built forward stack. Deliberately re-arms even when
   * the original window already expired: after a multi-second model build the
   * trailing flush lands long past the initial deadline, and it is exactly
   * that flush this extension must swallow. No-op when `resource` has no
   * pending suppression entry (a genuine navigation elsewhere already cleared
   * it).
   */
  settleNavigation(resource: URI): void

  canGoBack(): boolean
  canGoForward(): boolean

  /** Snapshot of the back stack, oldest first. */
  getBackStack(): readonly IHistoryStackEntry[]
  /** Snapshot of the forward stack, oldest first. */
  getForwardStack(): readonly IHistoryStackEntry[]

  /** Reset both stacks (test helper). */
  clear(): void
}

export const IHistoryService = createDecorator<IHistoryService>('historyService')
