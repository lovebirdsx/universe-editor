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

export interface IStatusBarService {
  readonly _serviceBrand: undefined

  addEntry(entry: IStatusBarEntry): IDisposable

  readonly onDidChangeEntries: Event<void>
}

export const IStatusBarService = createDecorator<IStatusBarService>('statusBarService')
