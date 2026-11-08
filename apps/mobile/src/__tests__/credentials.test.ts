import { describe, expect, it } from 'vitest'
import { createCredentialStore, type StoredCredentials } from '../credentials.js'

const credentials: StoredCredentials = {
  deviceId: 'device-12345678',
  token: 'token-value',
  pcName: 'DESKTOP-TEST',
  deviceName: 'Pixel 9',
  platform: 'android',
  protocolVersion: 1,
}

describe('createCredentialStore', () => {
  it('falls back to memory when IndexedDB is unavailable', async () => {
    const store = createCredentialStore(null)
    await expect(store.save(credentials)).resolves.toEqual({ persisted: false })
    await expect(store.load()).resolves.toEqual(credentials)

    await store.clear()
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('falls back to memory when IndexedDB open throws', async () => {
    const failingFactory = {
      open: () => {
        throw new Error('storage blocked')
      },
    } as unknown as IDBFactory
    const store = createCredentialStore(failingFactory)

    await expect(store.save(credentials)).resolves.toEqual({ persisted: false })
    await expect(store.load()).resolves.toEqual(credentials)
  })

  it('keeps the memory copy when a later indexedDB write fails', async () => {
    const failingFactory = {
      open: () => {
        throw new Error('quota exceeded')
      },
    } as unknown as IDBFactory
    const store = createCredentialStore(failingFactory)

    await store.save(credentials)
    const updated = { ...credentials, pcName: 'PC-TWO' }
    await expect(store.save(updated)).resolves.toEqual({ persisted: false })
    await expect(store.load()).resolves.toEqual(updated)
  })
})
