/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IStatusBarService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { IStatusBarService, IStatusBarEntry } from '@universe-editor/platform'
import { toDisposable } from '@universe-editor/platform'
import type { IDisposable } from '@universe-editor/platform'

interface StoredEntry {
  entry: IStatusBarEntry
  id: number
}

export class StatusBarService implements IStatusBarService {
  declare readonly _serviceBrand: undefined

  private readonly _entries: StoredEntry[] = []
  private _nextId = 0

  private readonly _emitter = new Emitter<void>()
  readonly onDidChangeEntries = this._emitter.event

  addEntry(entry: IStatusBarEntry): IDisposable {
    const id = this._nextId++
    this._entries.push({ entry, id })
    this._emitter.fire()

    return toDisposable(() => {
      const idx = this._entries.findIndex((e) => e.id === id)
      if (idx !== -1) {
        this._entries.splice(idx, 1)
        this._emitter.fire()
      }
    })
  }

  getEntries(): readonly StoredEntry[] {
    return this._entries
  }
}
