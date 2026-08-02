/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmApplyStore — renderer-side, persisted toggles for "Apply to Local":
 *  whether files outside the current workspace may be overwritten too (OFF by
 *  default — applying a review must not silently touch files the user can't
 *  see in the editor), and whether applied files are opened in the default
 *  changelist (ON by default — the historical behavior; OFF writes content to
 *  disk and immediately un-opens via `p4 revert -k`). Persisted GLOBAL because
 *  the toggles are about the user's p4 client, not the opened workspace.
 *  Module-level singleton with a never-disposed Emitter, mirroring
 *  swarmIgnoreStore.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, StorageScope, type Event, type IStorageService } from '@universe-editor/platform'

const INCLUDE_OUTSIDE_KEY = 'swarm.applyToLocal.includeOutsideWorkspace'
const INTO_CHANGELIST_KEY = 'swarm.applyToLocal.intoChangelist'

class SwarmApplyStore {
  private _storage: IStorageService | undefined
  private _includeOutside = false
  private _intoChangelist = true
  private readonly _onDidChange = new Emitter<void>()
  private _ready: Promise<void> | undefined
  private _isReady = false

  /** Fires after a toggle changed (setters / initial load). */
  readonly onDidChange: Event<void> = this._onDidChange.event

  /** Bind the storage backend and load the persisted toggles. Idempotent. */
  attach(storage: IStorageService): Promise<void> {
    if (this._ready) return this._ready
    this._storage = storage
    this._ready = (async () => {
      const persisted = await storage.get<boolean>(INCLUDE_OUTSIDE_KEY, StorageScope.GLOBAL)
      if (typeof persisted === 'boolean') this._includeOutside = persisted
      const persistedChangelist = await storage.get<boolean>(
        INTO_CHANGELIST_KEY,
        StorageScope.GLOBAL,
      )
      if (typeof persistedChangelist === 'boolean') this._intoChangelist = persistedChangelist
      this._isReady = true
      this._onDidChange.fire()
    })()
    return this._ready
  }

  /** Resolves once the persisted toggles are loaded (no-op if never attached). */
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

  get intoChangelist(): boolean {
    return this._intoChangelist
  }

  setIntoChangelist(value: boolean): void {
    if (this._intoChangelist === value) return
    this._intoChangelist = value
    void this._storage?.set(INTO_CHANGELIST_KEY, value, StorageScope.GLOBAL)
    this._onDidChange.fire()
  }
}

export const swarmApplyStore = new SwarmApplyStore()
