/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmApplyStore — renderer-side, persisted toggle for "Apply to Local": whether
 *  files outside the current workspace may be overwritten too. OFF by default
 *  (applying a review must not silently touch files the user can't see in the
 *  editor); persisted GLOBAL because the toggle is about the user's p4 client,
 *  not the opened workspace. Module-level singleton with a never-disposed
 *  Emitter, mirroring swarmIgnoreStore.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, StorageScope, type Event, type IStorageService } from '@universe-editor/platform'

const INCLUDE_OUTSIDE_KEY = 'swarm.applyToLocal.includeOutsideWorkspace'

class SwarmApplyStore {
  private _storage: IStorageService | undefined
  private _includeOutside = false
  private readonly _onDidChange = new Emitter<void>()
  private _ready: Promise<void> | undefined
  private _isReady = false

  /** Fires after the toggle changed (setIncludeOutside / initial load). */
  readonly onDidChange: Event<void> = this._onDidChange.event

  /** Bind the storage backend and load the persisted toggle. Idempotent. */
  attach(storage: IStorageService): Promise<void> {
    if (this._ready) return this._ready
    this._storage = storage
    this._ready = (async () => {
      const persisted = await storage.get<boolean>(INCLUDE_OUTSIDE_KEY, StorageScope.GLOBAL)
      if (typeof persisted === 'boolean') this._includeOutside = persisted
      this._isReady = true
      this._onDidChange.fire()
    })()
    return this._ready
  }

  /** Resolves once the persisted toggle is loaded (no-op if never attached). */
  get whenReady(): Promise<void> {
    return this._ready ?? Promise.resolve()
  }

  get isReady(): boolean {
    return this._isReady
  }

  get includeOutside(): boolean {
    return this._includeOutside
  }

  setIncludeOutside(value: boolean): void {
    if (this._includeOutside === value) return
    this._includeOutside = value
    void this._storage?.set(INCLUDE_OUTSIDE_KEY, value, StorageScope.GLOBAL)
    this._onDidChange.fire()
  }
}

export const swarmApplyStore = new SwarmApplyStore()
