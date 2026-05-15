/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IStatusBarService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, toDisposable } from '@universe-editor/platform'
import type {
  IStatusBarService,
  IStatusBarEntry,
  IStoredStatusBarEntry,
} from '@universe-editor/platform'

export class StatusBarService implements IStatusBarService {
  declare readonly _serviceBrand: undefined

  private _nextId = 0
  readonly entries = observableValue<readonly IStoredStatusBarEntry[]>(
    'StatusBarService.entries',
    [],
  )

  addEntry(entry: IStatusBarEntry): ReturnType<IStatusBarService['addEntry']> {
    const id = this._nextId++
    const stored: IStoredStatusBarEntry = { id, entry }
    this.entries.set([...this.entries.get(), stored], undefined)

    return toDisposable(() => {
      const current = this.entries.get()
      const idx = current.findIndex((e) => e.id === id)
      if (idx === -1) return
      this.entries.set([...current.slice(0, idx), ...current.slice(idx + 1)], undefined)
    })
  }
}
