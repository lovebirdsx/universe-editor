/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IHistoryService — bounded back/forward navigation history across editor inputs.
 *
 *  Each entry captures a (resource, selection) tuple; goBack/goForward emit the
 *  desired target without mutating editor state directly. Renderer wires the
 *  emissions to openEditor + restoreViewState. In-memory only; mirrors vscode.
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

export interface IHistoryEntry {
  readonly resource: URI
  readonly selection?: IHistorySelection | undefined
  /**
   * Editor input typeId, set by recorders when the entry corresponds to a
   * non-text editor (Settings, Welcome, Agents, ...). Used by GoBack/GoForward
   * to recreate the input via `EditorRegistry.deserialize(typeId, serialized)`
   * when no live instance is found in any group.
   */
  readonly typeId?: string
  /** Serialized payload from `EditorInput.serialize?.()` — paired with `typeId`. */
  readonly serialized?: unknown
  readonly timestamp: number
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

  /** Step one position back. Returns the entry to navigate to, or undefined. */
  goBack(): IHistoryEntry | undefined

  /** Step one position forward. Returns the entry to navigate to, or undefined. */
  goForward(): IHistoryEntry | undefined

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
  getBackStack(): readonly IHistoryEntry[]
  /** Snapshot of the forward stack, oldest first. */
  getForwardStack(): readonly IHistoryEntry[]

  /** Reset both stacks (test helper). */
  clear(): void
}

export const IHistoryService = createDecorator<IHistoryService>('historyService')
