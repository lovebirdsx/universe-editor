/*---------------------------------------------------------------------------------------------
 *  Tests for SecretStorageMainService — encrypt/decrypt round-trip, missing key,
 *  delete, and the no-plaintext-fallback guard when OS encryption is unavailable.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach } from 'vitest'
import type { Storage } from '../../../storage.js'
import { SecretStorageMainService, type SafeStorageLike } from '../secretStorageMainService.js'

/** In-memory Storage stub. */
function createStorage(): Storage {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    set: (key: string, value: unknown) => {
      data.set(key, value)
      return Promise.resolve()
    },
    remove: (key: string) => {
      data.delete(key)
      return Promise.resolve()
    },
    flush: () => Promise.resolve(),
    flushSync: () => {},
  }
}

/** Reversible "encryption" stub (base64 inside a Buffer) keyed on availability. */
function createSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').replace(/^enc:/, ''),
  }
}

describe('SecretStorageMainService', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createStorage()
  })

  it('round-trips set → get', async () => {
    const svc = new SecretStorageMainService(createSafeStorage(), storage)
    await svc.set('ai.secret.openai.apiKey', 'sk-123')
    expect(await svc.get('ai.secret.openai.apiKey')).toBe('sk-123')
  })

  it('returns undefined for a missing key', async () => {
    const svc = new SecretStorageMainService(createSafeStorage(), storage)
    expect(await svc.get('nope')).toBeUndefined()
  })

  it('delete removes the secret', async () => {
    const svc = new SecretStorageMainService(createSafeStorage(), storage)
    await svc.set('k', 'v')
    await svc.delete('k')
    expect(await svc.get('k')).toBeUndefined()
  })

  it('does not persist plaintext (ciphertext only on disk)', async () => {
    const svc = new SecretStorageMainService(createSafeStorage(), storage)
    await svc.set('k', 'super-secret')
    const persisted = await storage.get<Record<string, string>>('secrets')
    expect(JSON.stringify(persisted)).not.toContain('super-secret')
  })

  it('throws on set when encryption is unavailable (no silent plaintext)', async () => {
    const svc = new SecretStorageMainService(createSafeStorage(false), storage)
    await expect(svc.set('k', 'v')).rejects.toThrow(/unavailable/)
    expect(await storage.get('secrets')).toBeUndefined()
  })

  it('survives a fresh service instance over the same storage', async () => {
    const safe = createSafeStorage()
    await new SecretStorageMainService(safe, storage).set('k', 'v')
    const svc2 = new SecretStorageMainService(safe, storage)
    expect(await svc2.get('k')).toBe('v')
  })
})
