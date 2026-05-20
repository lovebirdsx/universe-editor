/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IStatusbarService (workbench/services/statusbar/browser/statusbar.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export const enum StatusBarAlignment {
  Left = 0,
  Right = 1,
}

/** Visual emphasis for a status-bar entry. */
export type StatusBarEntryKind = 'default' | 'prominent'

export interface IStatusBarEntry {
  readonly text: string
  readonly tooltip?: string
  /** Command to execute on click. */
  readonly command?: string
  readonly alignment: StatusBarAlignment
  /** Higher = further from center. */
  readonly priority: number
  /** Icon identifier (e.g. 'bell'). Renderer maps it to an SVG; platform stays icon-agnostic. */
  readonly icon?: string
  /** 'prominent' uses an attention foreground (e.g. unread counts). Defaults to inherited statusbar fg. */
  readonly kind?: StatusBarEntryKind
}

/** Entry as kept by the service: stable id + the original entry. */
export interface IStoredStatusBarEntry {
  readonly id: number
  readonly entry: IStatusBarEntry
}

/**
 * Handle returned by `IStatusBarService.addEntry`. Lets the caller swap the
 * entry's data in-place without losing its slot (the underlying id is stable
 * across updates, so React keys remain valid).
 */
export interface IStatusBarEntryAccessor extends IDisposable {
  update(entry: IStatusBarEntry): void
}

export interface IStatusBarService {
  readonly _serviceBrand: undefined

  addEntry(entry: IStatusBarEntry): IStatusBarEntryAccessor

  readonly entries: IObservable<readonly IStoredStatusBarEntry[]>
}

export const IStatusBarService = createDecorator<IStatusBarService>('statusBarService')
