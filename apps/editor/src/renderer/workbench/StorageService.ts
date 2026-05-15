import type { IStorageService } from '@universe-editor/platform'

export class StorageService implements IStorageService {
  declare readonly _serviceBrand: undefined

  get<T = unknown>(key: string): Promise<T | undefined> {
    return window.api.storage.get<T>(key)
  }

  set(key: string, value: unknown): Promise<void> {
    return window.api.storage.set(key, value)
  }
}
