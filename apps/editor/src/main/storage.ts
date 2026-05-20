import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  /** Wait for all pending writes to complete. */
  flush(): Promise<void>
}

export function createStorage(filePath: string): Storage {
  let cache: Record<string, unknown> | null = null
  // Serialize all writes so concurrent set() calls never race on disk.
  let writeChain: Promise<void> = Promise.resolve()

  const readAll = async (): Promise<Record<string, unknown>> => {
    if (cache) return cache
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      cache = {}
    }
    return cache
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const all = await readAll()
      return all[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      const all = await readAll()
      all[key] = value
      // Snapshot content now so a later mutation doesn't affect this write.
      const content = JSON.stringify(all, null, 2)
      // Chain onto the previous write; swallow previous errors so the chain
      // stays alive for future writes even if one write failed.
      writeChain = writeChain.catch(() => {}).then(() => fs.writeFile(filePath, content, 'utf8'))
      return writeChain
    },
    flush(): Promise<void> {
      return writeChain
    },
  }
}

let _defaultStorage: Storage | null = null

export function getDefaultStorage(): Storage {
  if (!_defaultStorage) {
    _defaultStorage = createStorage(join(app.getPath('userData'), 'state.json'))
  }
  return _defaultStorage
}
