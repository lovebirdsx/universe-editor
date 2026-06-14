/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Encrypted secret storage backed by Electron `safeStorage`. Ciphertext is
 *  persisted to the GLOBAL state.json via IMainStorageService; plaintext never
 *  leaves the main process and never lands in settings.json or the renderer.
 *--------------------------------------------------------------------------------------------*/

import { safeStorage } from 'electron'
import {
  createNamedLogger,
  Disposable,
  type ILogger,
  ILoggerService,
  type ISecretStorageService,
} from '@universe-editor/platform'
import { IMainStorageService, type Storage } from '../../storage.js'

/** Namespace for secret entries inside state.json. */
const SECRET_STORAGE_KEY = 'secrets'

/** Minimal slice of Electron's safeStorage so tests can stub it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

type SecretMap = Record<string, string>

export class SecretStorageMainService extends Disposable implements ISecretStorageService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    private readonly _safeStorage: SafeStorageLike = safeStorage,
    @IMainStorageService private readonly _storage?: Storage,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'secrets', name: 'Secret Storage' })
  }

  async get(key: string): Promise<string | undefined> {
    const map = await this._readMap()
    const encoded = map[key]
    if (encoded === undefined) return undefined
    if (!this._ensureAvailable()) return undefined
    try {
      return this._safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (err) {
      this._logger.warn(`failed to decrypt secret '${key}': ${(err as Error).message}`)
      return undefined
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this._ensureAvailable()) {
      throw new Error('Secret storage unavailable: OS encryption is not available')
    }
    const encoded = this._safeStorage.encryptString(value).toString('base64')
    const map = await this._readMap()
    map[key] = encoded
    await this._writeMap(map)
  }

  async delete(key: string): Promise<void> {
    const map = await this._readMap()
    if (!(key in map)) return
    delete map[key]
    await this._writeMap(map)
  }

  private _ensureAvailable(): boolean {
    // Never silently fall back to plaintext: if the OS keychain is unavailable,
    // refuse to encrypt/decrypt and surface it to the caller / log.
    if (!this._safeStorage.isEncryptionAvailable()) {
      this._logger.warn('OS encryption is not available; secrets cannot be stored')
      return false
    }
    return true
  }

  private async _readMap(): Promise<SecretMap> {
    const raw = await this._storage?.get<SecretMap>(SECRET_STORAGE_KEY)
    return raw && typeof raw === 'object' ? { ...raw } : {}
  }

  private async _writeMap(map: SecretMap): Promise<void> {
    await this._storage?.set(SECRET_STORAGE_KEY, map)
  }
}
