/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IStatusbarService (workbench/services/statusbar/browser/statusbar.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export const enum StatusBarAlignment {
  Left = 0,
  Right = 1,
}

export interface IStatusBarEntry {
  readonly text: string
  readonly tooltip?: string
  /** Command to execute on click. */
  readonly command?: string
  readonly alignment: StatusBarAlignment
  /** Higher = further from center. */
  readonly priority: number
}

/** Entry as kept by the service: stable id + the original entry. */
export interface IStoredStatusBarEntry {
  readonly id: number
  readonly entry: IStatusBarEntry
}

/** Immutable snapshot of status bar state. */
export interface StatusBarState {
  readonly entries: readonly IStoredStatusBarEntry[]
}

export interface IStatusBarService {
  readonly _serviceBrand: undefined

  addEntry(entry: IStatusBarEntry): IDisposable

  getSnapshot(): StatusBarState
  subscribe(listener: () => void): IDisposable

  /** @deprecated Legacy event. Prefer subscribe + getSnapshot. */
  readonly onDidChangeEntries: Event<void>
}

export const IStatusBarService = createDecorator<IStatusBarService>('statusBarService')
