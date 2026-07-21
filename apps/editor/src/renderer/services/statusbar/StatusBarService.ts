/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IStatusBarService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, observableValue, registerSingleton } from '@universe-editor/platform'
import {
  IStatusBarService,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  type IStoredStatusBarEntry,
} from '@universe-editor/platform'

export class StatusBarService implements IStatusBarService {
  declare readonly _serviceBrand: undefined

  private _nextId = 0
  readonly entries = observableValue<readonly IStoredStatusBarEntry[]>(
    'StatusBarService.entries',
    [],
  )

  addEntry(entry: IStatusBarEntry): IStatusBarEntryAccessor {
    const id = this._nextId++
    this.entries.set([...this.entries.get(), { id, entry }], undefined)

    return {
      update: (next: IStatusBarEntry) => {
        const current = this.entries.get()
        const idx = current.findIndex((e) => e.id === id)
        if (idx === -1) return
        const replaced = [...current]
        replaced[idx] = { id, entry: next }
        this.entries.set(replaced, undefined)
      },
      dispose: () => {
        const current = this.entries.get()
        const idx = current.findIndex((e) => e.id === id)
        if (idx === -1) return
        this.entries.set([...current.slice(0, idx), ...current.slice(idx + 1)], undefined)
      },
    }
  }
}

registerSingleton(IStatusBarService, StatusBarService, InstantiationType.Eager)
