import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDecorator } from '@universe-editor/platform'

export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** Wait for all pending writes to complete. */
  flush(): Promise<void>
  /**
   * Synchronously persist the latest in-memory state to disk. Meant for
   * Electron's `will-quit`, which does not wait for async writes — a fire-and-forget
   * `flush()` there can be cut off by process exit, truncating the file. No-op if
   * nothing has been read or written yet.
   */
  flushSync(): void
  /**
   * Test-only: flush pending writes, then drop the in-memory cache so the next
   * read re-loads from disk. The e2e shared-app reset re-seeds state.json
   * between tests but a window reload does NOT rebuild this backend — without
   * dropping the cache the new renderer keeps reading the previous test's
   * in-memory state.
   */
  reloadFromDisk?(): Promise<void>
}

// Application-singleton state.json backend, registered as a preset instance in the
// main DI container so services like RecentWorkspaces can inject it.
export const IMainStorageService = createDecorator<Storage>('mainStorageService')

export interface StorageOptions {
  /**
   * Backstop against persisting a single absurdly large value. Serializing and
   * shuttling a >100MB value through JSON.stringify / IPC can exhaust the
   * main-process heap and abort it (exit 134). Producers are expected to
   * enforce their own tighter budgets; this is the last line of defense —
   * the set() call rejects and the producer logs it instead of the process dying.
   */
  readonly maxValueBytes?: number
}

const DEFAULT_MAX_VALUE_BYTES = 64 * 1024 * 1024

export function createStorage(filePath: string, options: StorageOptions = {}): Storage {
  const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES
  const tmpPath = `${filePath}.tmp`
  const syncTmpPath = `${filePath}.synctmp`
  const bakPath = `${filePath}.bak`
  const corruptPath = `${filePath}.corrupt`
  let cache: Record<string, unknown> | null = null
  let loadPromise: Promise<Record<string, unknown>> | null = null
  // Coalesced writes: set/remove mutate `cache` and schedule ONE mergeable
  // write; serialization happens lazily inside that write from the latest
  // cache. At most one full-bucket string exists on the heap (the in-flight
  // write) — the old per-set writeChain froze a serialized copy of the whole
  // bucket into every queued closure, so a 32MB bucket × K queued writes
  // pinned the main-process heap until V8 aborted with OOM.
  let lastWrite: Promise<void> | null = null
  let mergeableWrite: Promise<void> | null = null

  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  const readAll = async (): Promise<Record<string, unknown>> => {
    if (cache) return cache
    if (loadPromise) return loadPromise
    loadPromise = (async (): Promise<Record<string, unknown>> => {
      let raw: string | null = null
      try {
        raw = await fs.readFile(filePath, 'utf8')
      } catch {
        raw = null
      }
      if (raw !== null) {
        const parsed = tryParse(raw)
        if (parsed) {
          cache = parsed
          return cache
        }
        // File exists but is unparseable: preserve it for diagnostics, then fall
        // back to the last-good backup instead of silently starting empty (which
        // would let the next write erase everything that survived).
        try {
          await fs.rename(filePath, corruptPath)
        } catch {
          // best-effort
        }
      }
      let bakRaw: string | null = null
      try {
        bakRaw = await fs.readFile(bakPath, 'utf8')
      } catch {
        bakRaw = null
      }
      cache = (bakRaw !== null ? tryParse(bakRaw) : null) ?? {}
      return cache
    })()
    try {
      return await loadPromise
    } finally {
      loadPromise = null
    }
  }

  // Atomic promotion: write a temp file, rotate the current file to .bak, then
  // rename the temp into place. A crash at any point leaves either the previous
  // file or a recoverable .bak — never a half-written primary file.
  const promote = (tmp: string): void => {
    try {
      renameSync(filePath, bakPath)
    } catch {
      // first write — no existing file to back up
    }
    renameSync(tmp, filePath)
  }

  const writeAll = async (content: string): Promise<void> => {
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf8')
    try {
      await fs.rename(filePath, bakPath)
    } catch {
      // first write — no existing file to back up
    }
    await fs.rename(tmpPath, filePath)
  }

  /**
   * Resolves once a write carrying every cache mutation made so far has
   * landed on disk. Mutations made while a write is in-flight (or while no
   * write has started yet) merge into one queued write — its serialization
   * runs only when the write actually begins, off the latest cache.
   * A failed write rejects this call but never wedges the queue; the cache
   * keeps the mutation so the next scheduled write re-persists it.
   */
  const scheduleWrite = (): Promise<void> => {
    if (mergeableWrite) return mergeableWrite
    const previous = lastWrite ?? Promise.resolve()
    const write = previous
      .catch(() => {})
      .then(async () => {
        // Close the merge window the moment serialization begins: a mutation
        // landing while the disk write is in flight needs a fresh follow-up
        // write, or its set() promise would resolve against a stale snapshot
        // and the value would sit unpersisted until some later write.
        if (mergeableWrite === write) mergeableWrite = null
        const snapshot = cache
        if (snapshot === null) return
        await writeAll(JSON.stringify(snapshot, null, 2))
      })
    mergeableWrite = write
    lastWrite = write
    void write.then(
      () => {
        if (lastWrite === write) lastWrite = null
      },
      () => {
        if (lastWrite === write) lastWrite = null
      },
    )
    return write
  }

  const flushPendingWrites = async (): Promise<void> => {
    // Await the current tail, then re-check: the awaited write itself may
    // have scheduled a follow-up (mutations that arrived mid-flight).
    for (let current = lastWrite; current !== null; current = lastWrite) {
      await current.catch(() => {})
    }
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const all = await readAll()
      return all[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      const valueBytes = JSON.stringify(value)?.length ?? 0
      if (valueBytes > maxValueBytes) {
        throw new Error(
          `refusing to persist "${key}": serialized value is ${(valueBytes / 1024 / 1024).toFixed(1)}MB (limit ${(maxValueBytes / 1024 / 1024).toFixed(0)}MB)`,
        )
      }
      const all = await readAll()
      all[key] = value
      await scheduleWrite()
    },
    async remove(key: string): Promise<void> {
      const all = await readAll()
      if (!(key in all)) return
      delete all[key]
      await scheduleWrite()
    },
    flush(): Promise<void> {
      return flushPendingWrites()
    },
    async reloadFromDisk(): Promise<void> {
      await flushPendingWrites()
      cache = null
    },
    flushSync(): void {
      if (cache === null) return
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        // Dedicated sync temp file so this can't collide with an in-flight async
        // writeAll() using tmpPath. No pretty-print: this runs on will-quit, where
        // a smaller serialization shaves the synchronous write that gates exit.
        writeFileSync(syncTmpPath, JSON.stringify(cache), 'utf8')
        promote(syncTmpPath)
      } catch {
        // best-effort durability backstop
      }
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
