/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Encrypted secret storage contract. Interface only — the implementation lives
 *  in the main process (Electron safeStorage + IStorageService). Secrets never
 *  reach the renderer or settings.json.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface ISecretStorageService {
  readonly _serviceBrand: undefined
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export const ISecretStorageService = createDecorator<ISecretStorageService>('secretStorageService')
