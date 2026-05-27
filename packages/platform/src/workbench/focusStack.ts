/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFocusStackService — records the user's recent focus history across Parts /
 *  Views / EditorGroups so navigation commands (F6, lastFocusedView restore)
 *  and Monaco blur arbitration can ask "where did the user last want focus?"
 *
 *  Push-order semantics: each newly-focused location is appended to the top
 *  (the latest entry). Stale entries deeper than MAX_DEPTH are evicted.
 *  Renderer-only; implementation lives in apps/editor.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { PartId } from './layoutService.js'

export interface IFocusEntry {
  readonly partId: PartId
  readonly viewId?: string | undefined
  readonly groupId?: number | undefined
  readonly timestamp: number
}

export interface IFocusStackService {
  readonly _serviceBrand: undefined

  readonly onDidChange: Event<void>

  /** Append a new entry to the top of the stack. Replaces consecutive duplicates. */
  push(entry: Omit<IFocusEntry, 'timestamp'>): void

  /** Most recent entry (top of stack). */
  getTop(): IFocusEntry | undefined

  /** Snapshot of all entries, top first. */
  getAll(): readonly IFocusEntry[]

  /** Next visible part for F6. Skips hidden parts. Wraps around. */
  nextPart(): PartId | undefined

  /** Previous visible part for Shift+F6. Skips hidden parts. Wraps around. */
  previousPart(): PartId | undefined

  /** Clear the stack (test helper). */
  clear(): void
}

export const IFocusStackService = createDecorator<IFocusStackService>('focusStackService')
