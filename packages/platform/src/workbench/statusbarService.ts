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

export interface IStatusBarService {
  readonly _serviceBrand: undefined

  addEntry(entry: IStatusBarEntry): IDisposable

  readonly entries: IObservable<readonly IStoredStatusBarEntry[]>
}

export const IStatusBarService = createDecorator<IStatusBarService>('statusBarService')
