/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IStatusBarService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, toDisposable } from '@universe-editor/platform'
import type {
  IStatusBarService,
  IStatusBarEntry,
  IStoredStatusBarEntry,
  StatusBarState,
  IDisposable,
} from '@universe-editor/platform'

const EMPTY_STATE: StatusBarState = Object.freeze({
  entries: Object.freeze([]) as readonly IStoredStatusBarEntry[],
})

export class StatusBarService implements IStatusBarService {
  declare readonly _serviceBrand: undefined

  private _state: StatusBarState = EMPTY_STATE
  private _nextId = 0

  private readonly _onChange = new Emitter<void>()
  private readonly _onDidChangeEntries = new Emitter<void>()
  readonly onDidChangeEntries = this._onDidChangeEntries.event

  getSnapshot(): StatusBarState {
    return this._state
  }

  subscribe(listener: () => void): IDisposable {
    return this._onChange.event(listener)
  }

  addEntry(entry: IStatusBarEntry): IDisposable {
    const id = this._nextId++
    const stored: IStoredStatusBarEntry = Object.freeze({ id, entry })
    this._commit(
      Object.freeze({
        entries: Object.freeze([
          ...this._state.entries,
          stored,
        ]) as readonly IStoredStatusBarEntry[],
      }),
    )

    return toDisposable(() => {
      const idx = this._state.entries.findIndex((e) => e.id === id)
      if (idx === -1) return
      this._commit(
        Object.freeze({
          entries: Object.freeze([
            ...this._state.entries.slice(0, idx),
            ...this._state.entries.slice(idx + 1),
          ]) as readonly IStoredStatusBarEntry[],
        }),
      )
    })
  }

  private _commit(next: StatusBarState): void {
    if (next === this._state) return
    this._state = next
    this._onChange.fire()
    this._onDidChangeEntries.fire()
  }
}
