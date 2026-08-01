/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Scroll-position persister for the settings editor: keeps an in-memory map
 *  for synchronous reads (useScrollRestore's load contract) and mirrors writes
 *  to IStorageService (GLOBAL) on a debounce, so positions survive a reload.
 *  One shared instance per storage service — created lazily from the editor.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope } from '@universe-editor/platform'
import type { IScrollStatePersister } from '@universe-editor/workbench-ui'

const SAVE_DEBOUNCE_MS = 200

export class SettingsScrollPersister implements IScrollStatePersister {
  private readonly _positions = new Map<string, number>()
  private readonly _pending = new Map<string, number>()
  private _timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly _storage: IStorageService) {}

  load(key: string): number | undefined {
    return this._positions.get(key)
  }

  save(key: string, scrollTop: number): void {
    this._positions.set(key, scrollTop)
    this._pending.set(key, scrollTop)
    if (this._timer !== undefined) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = undefined
      void this._flush()
    }, SAVE_DEBOUNCE_MS)
  }

  private async _flush(): Promise<void> {
    const pending = [...this._pending]
    this._pending.clear()
    for (const [key, value] of pending) {
      await this._storage.set(key, value, StorageScope.GLOBAL)
    }
  }

  /** Hydrate the in-memory map from durable storage; call once per mount. */
  async prefetch(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        const value = await this._storage.get<number>(key, StorageScope.GLOBAL)
        if (typeof value === 'number' && value > 0) this._positions.set(key, value)
      }),
    )
  }
}
