import type { PairDevicePlatform } from '@universe-editor/mobile-protocol'

export interface StoredCredentials {
  readonly deviceId: string
  readonly token: string
  readonly pcName: string
  readonly deviceName: string
  readonly platform: PairDevicePlatform
  readonly protocolVersion: number
}

export interface SaveCredentialsResult {
  /** False when IndexedDB is unavailable and credentials only live in memory. */
  readonly persisted: boolean
}

export interface CredentialStore {
  load(): Promise<StoredCredentials | undefined>
  save(credentials: StoredCredentials): Promise<SaveCredentialsResult>
  clear(): Promise<void>
}

const DB_NAME = 'universe-mobile'
const DB_VERSION = 1
const STORE_NAME = 'credentials'
const RECORD_KEY = 'device'

/**
 * IndexedDB-backed credential storage with a memory fallback for private modes
 * or blocked storage. Passing `null` forces the fallback (used by tests).
 */
export function createCredentialStore(factory?: IDBFactory | null): CredentialStore {
  const idb = factory === null ? undefined : (factory ?? resolveIndexedDb())
  let memory: StoredCredentials | undefined

  const readMemory = (): StoredCredentials | undefined => memory

  return {
    async load(): Promise<StoredCredentials | undefined> {
      if (memory !== undefined) return readMemory()
      if (idb === undefined) return undefined
      try {
        const db = await openDatabase(idb)
        try {
          memory = await readRecord(db)
        } finally {
          db.close()
        }
      } catch {
        // Memory fallback; the caller sees undefined and can still pair again.
      }
      return readMemory()
    },

    async save(credentials: StoredCredentials): Promise<SaveCredentialsResult> {
      memory = credentials
      if (idb === undefined) return { persisted: false }
      try {
        const db = await openDatabase(idb)
        try {
          await writeRecord(db, credentials)
          return { persisted: true }
        } finally {
          db.close()
        }
      } catch {
        return { persisted: false }
      }
    },

    async clear(): Promise<void> {
      memory = undefined
      if (idb === undefined) return
      try {
        const db = await openDatabase(idb)
        try {
          await deleteRecord(db)
        } finally {
          db.close()
        }
      } catch {
        // The memory copy is already gone; a failed delete only leaves a stale
        // record that the next successful load would overwrite.
      }
    },
  }
}

function resolveIndexedDb(): IDBFactory | undefined {
  if (typeof globalThis.indexedDB === 'undefined') return undefined
  return globalThis.indexedDB
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(DB_NAME, DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

function readRecord(db: IDBDatabase): Promise<StoredCredentials | undefined> {
  return new Promise<StoredCredentials | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY)
    request.onsuccess = () => {
      resolve(isStoredCredentials(request.result) ? request.result : undefined)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
  })
}

function writeRecord(db: IDBDatabase, credentials: StoredCredentials): Promise<void> {
  return runTransaction(db, 'readwrite', (store) => store.put(credentials, RECORD_KEY))
}

function deleteRecord(db: IDBDatabase): Promise<void> {
  return runTransaction(db, 'readwrite', (store) => store.delete(RECORD_KEY))
}

function runTransaction(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    action(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
  })
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['deviceId'] === 'string' &&
    typeof record['token'] === 'string' &&
    typeof record['pcName'] === 'string' &&
    typeof record['deviceName'] === 'string' &&
    (record['platform'] === 'ios' ||
      record['platform'] === 'android' ||
      record['platform'] === 'other') &&
    typeof record['protocolVersion'] === 'number'
  )
}
