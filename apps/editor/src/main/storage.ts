import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
}

export function createStorage(filePath: string): Storage {
  let cache: Record<string, unknown> | null = null

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
      await fs.writeFile(filePath, JSON.stringify(all, null, 2), 'utf8')
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
