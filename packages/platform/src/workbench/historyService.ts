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
  readonly timestamp: number
}

export interface IHistoryService {
  readonly _serviceBrand: undefined

  readonly onDidChange: Event<void>

  /** Record `entry` as the latest navigation point. Drops the forward stack. */
  record(entry: Omit<IHistoryEntry, 'timestamp'>): void

  /** Step one position back. Returns the entry to navigate to, or undefined. */
  goBack(): IHistoryEntry | undefined

  /** Step one position forward. Returns the entry to navigate to, or undefined. */
  goForward(): IHistoryEntry | undefined

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
