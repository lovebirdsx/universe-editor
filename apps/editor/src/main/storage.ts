import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
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

  const writeAll = async (content: string): Promise<void> => {
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const all = await readAll()
      return all[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      const all = await readAll()
      all[key] = value
      const content = JSON.stringify(all, null, 2)
      writeChain = writeChain.catch(() => {}).then(() => writeAll(content))
      return writeChain
    },
    async remove(key: string): Promise<void> {
      const all = await readAll()
      if (!(key in all)) return
      delete all[key]
      const content = JSON.stringify(all, null, 2)
      writeChain = writeChain.catch(() => {}).then(() => writeAll(content))
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

/** Stable filesystem-safe id for a workspace, derived from its URI string. */
export function workspaceIdFromUri(uriString: string): string {
  return createHash('sha1').update(uriString).digest('hex').slice(0, 16)
}

/** Backend file path for a given workspace id, under `<userData>/workspaces/`. */
export function workspaceStoragePath(workspaceId: string): string {
  return join(app.getPath('userData'), 'workspaces', `${workspaceId}.json`)
}
