/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire-facing storage service. Implements `IStorageService` directly (single-layer
 *  interface shared with the renderer via ProxyChannel).
 *--------------------------------------------------------------------------------------------*/

import { type IStorageService } from '@universe-editor/platform'
import { getDefaultStorage, type Storage } from '../../storage.js'

export class MainStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _storage: Storage = getDefaultStorage()) {}

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this._storage.get<T>(key)
  }

  set(key: string, value: unknown): Promise<void> {
    return this._storage.set(key, value)
  }

  flush(): Promise<void> {
    return this._storage.flush()
  }
}
