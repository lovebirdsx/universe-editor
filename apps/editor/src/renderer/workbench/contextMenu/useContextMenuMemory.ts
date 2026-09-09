/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useContextMenuMemory — bridges the workbench-ui `IContextMenuMemory` port to
 *  `IStorageService`. Reads are served synchronously from an in-memory cache so
 *  the menu's opening highlight can be chosen in a `useState` initializer; the
 *  cache is warmed once on first use and writes go through in the background
 *  (fire-and-forget — a lost write only means the next menu opens on the first
 *  row again, which is the pre-feature behaviour anyway).
 *--------------------------------------------------------------------------------------------*/

import { IStorageService } from '@universe-editor/platform'
import type { IContextMenuMemory } from '@universe-editor/workbench-ui'
import { useOptionalService } from '../useService.js'

const STORAGE_KEY = 'contextMenu.lastExecuted'

/** Serializable shape persisted under `STORAGE_KEY`. */
type PersistedMemory = Record<string, string>

function bucketKey(scope: string, contextTag: string | undefined): string {
  return `${scope}|${contextTag ?? ''}`
}

class StorageBackedContextMenuMemory implements IContextMenuMemory {
  private _cache: PersistedMemory = {}
  private _loadPromise: Promise<void> | undefined

  constructor(private readonly _storage: IStorageService) {}

  /**
   * Warm the in-memory cache. Idempotent: only the first call goes to storage.
   *
   * Merge semantics: if `set` ran while the load was in flight (a fast picker
   * on the very first menu), those entries survive — a wholesale overwrite
   * would permanently drop them, and the next `set` would persist the hole.
   */
  async preload(): Promise<void> {
    this._loadPromise ??= this._storage
      .get<PersistedMemory>(STORAGE_KEY)
      .then((loaded) => {
        // Cache wins on conflicts — entries written during the load are newer
        // than whatever was on disk.
        this._cache = { ...(loaded ?? {}), ...this._cache }
      })
      .catch(() => {
        // A transient IPC failure leaves the feature off for this session.
        // Still flag the load as done so a later transient success can't
        // clobber entries written in the meantime.
      })
    return this._loadPromise
  }

  get(scope: string, contextTag: string | undefined): string | undefined {
    return this._cache[bucketKey(scope, contextTag)]
  }

  set(scope: string, contextTag: string | undefined, itemId: string): void {
    this._cache[bucketKey(scope, contextTag)] = itemId
    // Persist in the background. No debounce: writes are tiny and the volume
    // is bounded by how fast a user can pick menu items.
    void this._storage.set(STORAGE_KEY, this._cache)
  }
}

/**
 * One memory instance per IStorageService: every context menu in the workbench
 * must read/write the same cache, otherwise a command picked from one menu
 * would not be remembered when another component raises that same menu later.
 * The production container holds a single storage service, so this behaves as
 * a singleton; unit tests bind a fresh stub per suite and get fresh instances
 * for free — a plain module singleton would leak picks across them.
 *
 * `preload` fires the moment the instance is created (not in an effect) so
 * the cache starts warming before the first menu ever opens — by the time the
 * user presses the ContextMenu key, the round-trip is usually already done.
 * The first-ever open can still race the load; it falls back to the first row
 * for that one menu, then every subsequent open hits the warm cache.
 */
const shared = new WeakMap<IStorageService, StorageBackedContextMenuMemory>()

/**
 * Resolve the shared `IContextMenuMemory` backed by `IStorageService`.
 *
 * Returns `undefined` when no `IStorageService` is bound (unit tests rendering
 * a menu outside `<Workbench>`): the menu then simply behaves as if the feature
 * were off — opening on the first row, recording nothing.
 */
export function useContextMenuMemory(): IContextMenuMemory | undefined {
  const storage = useOptionalService(IStorageService)
  if (storage === undefined) return undefined
  let memory = shared.get(storage)
  if (memory === undefined) {
    memory = new StorageBackedContextMenuMemory(storage)
    void memory.preload()
    shared.set(storage, memory)
  }
  return memory
}
