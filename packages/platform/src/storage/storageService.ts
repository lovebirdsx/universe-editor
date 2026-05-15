/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-facing key-value storage service. Implementations bridge to host storage.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface IStorageService {
  readonly _serviceBrand: undefined
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
}

export const IStorageService = createDecorator<IStorageService>('storageService')
