/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadStorage — the renderer end of `context.globalState` / `workspaceState`.
 *  The extension host keeps an in-memory mirror per extension (so the public
 *  `Memento.get` can stay synchronous) and reads/flushes the whole object through
 *  here. We persist each extension's state under a namespaced key in
 *  IStorageService, so plugins can neither read nor clobber each other's state.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope } from '@universe-editor/platform'
import type { ExtHostStorageScope, IMainThreadStorage } from '@universe-editor/extensions-common'

/** Namespace every extension's state under this prefix to avoid colliding with
 *  workbench storage keys. */
function storageKey(extId: string): string {
  return `extensions.state.${extId}`
}

function toScope(scope: ExtHostStorageScope): StorageScope {
  return scope === 1 ? StorageScope.WORKSPACE : StorageScope.GLOBAL
}

export class MainThreadStorage implements IMainThreadStorage {
  constructor(private readonly _storage: IStorageService) {}

  async $get(scope: ExtHostStorageScope, extId: string): Promise<string | undefined> {
    const value = await this._storage.get<string>(storageKey(extId), toScope(scope))
    return value === undefined ? undefined : value
  }

  $set(scope: ExtHostStorageScope, extId: string, valueJson: string): Promise<void> {
    return this._storage.set(storageKey(extId), valueJson, toScope(scope))
  }
}
