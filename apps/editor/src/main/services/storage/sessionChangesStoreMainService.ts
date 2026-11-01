/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Main-process owner of the per-session ACP change shards.
 *
 *  Why this exists: the tracker used to persist one `acp.sessionChanges` value
 *  holding every session. A workspace with ~33M characters of session history
 *  then made every small edit serialize and ship the whole history to main, and
 *  main rewrote the whole workspace bucket. Here each session is a separate
 *  file (through `createStorage`, so atomic writes/coalescing/flush stay in one
 *  place) and one small manifest carries only ids, sizes and LRU order.
 *
 *  A handle returned by `openBucket` pins a bucket. Writes made through it keep
 *  landing in that bucket even after the window switches workspace, which is
 *  exactly what stops a tail write from the old workspace mutating the new one.
 *
 *  The legacy state is imported here, in main, before the renderer ever sees the
 *  data. The legacy key is removed only after every session shard has been
 *  written, flushed and read back. Any failure leaves the legacy value in place
 *  and is reported; an unrecognized shape is never deleted.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IDisposable, ILogger, ILoggerService } from '@universe-editor/platform'
import { StorageScope } from '@universe-editor/platform'
import { createStorage, type Storage } from '../../storage.js'
import type {
  ISessionChangesStoreService,
  SessionChangesBucketInfo,
  SessionChangesReadResult,
  SessionChangesShardMeta,
  SessionChangesWriteResult,
} from '../../../shared/ipc/sessionChangesStoreService.js'
import type { MainStorageService } from './storageMainService.js'

const LEGACY_KEY = 'acp.sessionChanges'
const MANIFEST_KEY = 'manifest'
const SHARD_KEY = 'data'
const MANIFEST_SCHEMA_VERSION = 1
const SESSIONS_DIR = 'sessions'

interface ManifestEntry {
  readonly sessionId: string
  readonly bytes: number
}

interface ManifestDoc {
  readonly schemaVersion: number
  readonly sessions: readonly ManifestEntry[]
}

interface LegacySession {
  readonly sessionId: string
  readonly files: readonly unknown[]
}

type JsonReadResult =
  | { readonly status: 'ok'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: string }

/**
 * Module-level so two windows looking at the same bucket share one queue and
 * one in-memory manifest. GLOBAL is shared by every empty window; a workspace
 * can also be opened by more than one window. Keyed by the bucket directory.
 */
const sharedBuckets = new Map<string, Bucket>()
/** Serializes the one-time legacy import per bucket directory. */
const migrationByDir = new Map<string, Promise<string | undefined>>()

class Bucket {
  readonly manifestStorage: Storage
  readonly shardStorages = new Map<string, Storage>()
  manifest: ManifestDoc = { schemaVersion: MANIFEST_SCHEMA_VERSION, sessions: [] }
  manifestUnavailable = false
  manifestWarning: string | undefined
  readonly ready: Promise<string | undefined>
  private _queue: Promise<void> = Promise.resolve()
  /** Handles currently pinning this bucket, across every window's store. */
  private _refs = 0

  acquire(): void {
    this._refs++
  }

  /** True when the caller released the last handle for this bucket. */
  release(): boolean {
    this._refs--
    return this._refs <= 0
  }

  /** Drop every cached body so an idle bucket costs no main-process heap. */
  releaseCaches(): void {
    this.shardStorages.clear()
    this.manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, sessions: [] }
  }

  constructor(
    readonly dir: string,
    readonly scope: StorageScope,
    readonly workspaceId: string | null,
    readonly legacyStorage: Storage,
    readonly logger: ILogger,
  ) {
    this.manifestStorage = createStorage(join(dir, 'manifest.json'))
    this.ready = this._initialize()
  }

  private async _initialize(): Promise<string | undefined> {
    const existing = migrationByDir.get(this.dir)
    if (existing) return existing
    const promise = (async () => {
      await this._loadManifest()
      if (this.manifestUnavailable) {
        this.logger.warn(
          `session changes bucket ${this.label} has an unrecognized manifest; it is kept as-is`,
        )
        return 'manifest-unrecognized'
      }
      return this._migrateLegacy()
    })()
    migrationByDir.set(this.dir, promise)
    try {
      return await promise
    } catch (err) {
      return `migration-failed: ${(err as Error).message}`
    }
  }

  get label(): string {
    return this.workspaceId === null ? 'global' : `workspace:${this.workspaceId}`
  }

  private async _loadManifest(): Promise<void> {
    const read = await readJsonFile(join(this.dir, 'manifest.json'))
    if (read.status === 'missing') return
    if (read.status === 'error') {
      this.manifestUnavailable = true
      this.manifestWarning = read.error
      return
    }
    // The file is a `createStorage` bucket: `{ manifest: ManifestDoc }`.
    const raw = read.value
    const doc =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>)[MANIFEST_KEY]
        : undefined
    if (!isManifestDoc(doc)) {
      this.manifestUnavailable = true
      this.manifestWarning = 'unrecognized manifest shape'
      return
    }
    this.manifest = doc
  }

  /**
   * The manifest is unavailable (unrecognized). Recover the list from the shard
   * files themselves so the sessions stay visible, without ever overwriting the
   * file we could not understand.
   */
  async list(): Promise<readonly SessionChangesShardMeta[]> {
    if (!this.manifestUnavailable) {
      return this.manifest.sessions.map((s) => ({ sessionId: s.sessionId, bytes: s.bytes }))
    }
    return this._scanShards()
  }

  private async _scanShards(): Promise<readonly SessionChangesShardMeta[]> {
    let names: string[]
    try {
      names = await fs.readdir(join(this.dir, SESSIONS_DIR))
    } catch {
      return []
    }
    const metas: Array<SessionChangesShardMeta & { mtime: number }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.dir, SESSIONS_DIR, name)
      const read = await readJsonFile(file)
      if (read.status !== 'ok') continue
      const payload = shardPayload(read.value)
      if (payload === undefined || typeof payload.sessionId !== 'string') continue
      let mtime = 0
      try {
        mtime = (await fs.stat(file)).mtimeMs
      } catch {
        // best-effort ordering
      }
      metas.push({ sessionId: payload.sessionId, bytes: jsonSize(payload), mtime })
    }
    metas.sort((a, b) => a.mtime - b.mtime)
    return metas.map(({ sessionId, bytes }) => ({ sessionId, bytes }))
  }

  private async _migrateLegacy(): Promise<string | undefined> {
    let legacy: unknown
    try {
      legacy = await this.legacyStorage.get(LEGACY_KEY)
    } catch (err) {
      const message = `failed to read legacy ${LEGACY_KEY}: ${(err as Error).message}`
      this.logger.warn(message)
      return message
    }
    if (legacy === undefined) return undefined
    if (!isLegacyShape(legacy)) {
      const description = describeLegacy(legacy)
      this.logger.warn(
        `leaving legacy ${LEGACY_KEY} untouched — unrecognized shape (${description})`,
      )
      return `legacy-unrecognized (${description})`
    }
    const sessions = validateLegacySessions(legacy.sessions)
    if (sessions === undefined) {
      this.logger.warn(`leaving legacy ${LEGACY_KEY} untouched — malformed session entries`)
      return 'legacy-malformed'
    }

    this.logger.info(
      `importing legacy ${LEGACY_KEY} for ${this.label}: ${sessions.length} sessions`,
    )
    let migrated = 0
    try {
      for (const session of sessions) {
        const existing = this.manifest.sessions.find((s) => s.sessionId === session.sessionId)
        if (existing !== undefined) continue
        const payload = {
          schemaVersion: legacy.schemaVersion,
          sessionId: session.sessionId,
          files: session.files,
        }
        const file = this.shardPath(session.sessionId)
        // A shard file without a manifest entry is data a previous partial
        // import (or a newer writer) already committed. Adopt it rather than
        // overwriting it with the older legacy copy.
        const current = await readJsonFile(file)
        if (current.status === 'ok') {
          const read = shardPayload(current.value)
          if (read === undefined || read.sessionId !== session.sessionId) {
            throw new Error(`existing shard ${session.sessionId} is unreadable`)
          }
          await this._appendManifest(session.sessionId, jsonSize(read))
          await yieldToEventLoop()
          continue
        }
        if (current.status === 'error') {
          throw new Error(`existing shard ${session.sessionId} is unreadable: ${current.error}`)
        }
        await this._writeShardFile(session.sessionId, payload)
        const verify = await this._readShardFile(session.sessionId)
        if (verify.status !== 'ok' || shardSessionId(verify.payload) !== session.sessionId) {
          throw new Error(`verification failed for session ${session.sessionId}`)
        }
        await this._appendManifest(session.sessionId, jsonSize(payload))
        migrated++
        await yieldToEventLoop()
      }
    } catch (err) {
      // Every shard written so far is already in the manifest, so a retry is
      // idempotent. The legacy value stays until the whole set verifies.
      const message = `legacy import failed for ${this.label}: ${(err as Error).message}; legacy data kept`
      this.logger.warn(message)
      return message
    }

    try {
      await this.legacyStorage.remove(LEGACY_KEY)
    } catch (err) {
      const message = `legacy import complete but removing ${LEGACY_KEY} failed: ${(err as Error).message}`
      this.logger.warn(message)
      return message
    }
    this.logger.info(`legacy ${LEGACY_KEY} imported for ${this.label}: ${migrated} sessions`)
    return migrated > 0 ? `migrated:${migrated}` : undefined
  }

  private async _appendManifest(sessionId: string, bytes: number): Promise<void> {
    const sessions = this.manifest.sessions.filter((s) => s.sessionId !== sessionId)
    sessions.push({ sessionId, bytes })
    this.manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, sessions }
    if (this.manifestUnavailable) return
    await this.manifestStorage.set(MANIFEST_KEY, this.manifest)
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  shardPath(sessionId: string): string {
    const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
    return join(this.dir, SESSIONS_DIR, `${name}.json`)
  }

  async _writeShardFile(sessionId: string, payload: unknown): Promise<void> {
    const file = this.shardPath(sessionId)
    let storage = this.shardStorages.get(file)
    if (!storage) {
      storage = createStorage(file)
      this.shardStorages.set(file, storage)
    }
    await storage.set(SHARD_KEY, payload)
  }

  async _readShardFile(sessionId: string): Promise<SessionChangesReadResult> {
    const read = await readJsonFile(this.shardPath(sessionId))
    if (read.status === 'missing') return { status: 'missing' }
    if (read.status === 'error') return { status: 'error', error: read.error }
    const payload = shardPayload(read.value)
    if (payload === undefined) return { status: 'error', error: 'unrecognized shard shape' }
    if (payload.sessionId !== sessionId) {
      return { status: 'error', error: 'shard session id mismatch' }
    }
    return { status: 'ok', payload }
  }

  async _removeShardFile(sessionId: string): Promise<void> {
    const file = this.shardPath(sessionId)
    const storage = this.shardStorages.get(file)
    if (storage) {
      try {
        await storage.flush()
      } catch {
        // best-effort; removal below removes every file the backend uses
      }
      this.shardStorages.delete(file)
    }
    for (const path of [file, `${file}.tmp`, `${file}.synctmp`, `${file}.bak`]) {
      try {
        await fs.rm(path, { force: true })
      } catch {
        // best-effort
      }
    }
  }

  async write(sessionId: string, payload: unknown): Promise<SessionChangesWriteResult> {
    return this.enqueue(async () => {
      try {
        await this._writeShardFile(sessionId, payload)
        await this._appendManifest(sessionId, jsonSize(payload))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  async remove(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      await this._removeShardFile(sessionId)
      const sessions = this.manifest.sessions.filter((s) => s.sessionId !== sessionId)
      this.manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, sessions }
      if (!this.manifestUnavailable) {
        try {
          await this.manifestStorage.set(MANIFEST_KEY, this.manifest)
        } catch (err) {
          this.logger.warn(
            `failed to update session changes manifest for ${this.label}: ${(err as Error).message}`,
          )
        }
      }
    })
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      await this.manifestStorage.flush()
      for (const storage of this.shardStorages.values()) await storage.flush()
    })
  }

  flushSync(): void {
    try {
      this.manifestStorage.flushSync()
    } catch {
      // best-effort
    }
    for (const storage of this.shardStorages.values()) {
      try {
        storage.flushSync()
      } catch {
        // best-effort
      }
    }
  }
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

async function readJsonFile(file: string): Promise<JsonReadResult> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: (err as Error).message }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch (err) {
    return { status: 'error', error: `unparseable json: ${(err as Error).message}` }
  }
}

/** A shard file is `{ data: { schemaVersion, sessionId, files } }`. */
function shardPayload(
  raw: unknown,
): { schemaVersion: number; sessionId: unknown; files: unknown } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = (raw as Record<string, unknown>)[SHARD_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const payload = value as Record<string, unknown>
  if (typeof payload.schemaVersion !== 'number') return undefined
  if (!Array.isArray(payload.files)) return undefined
  return {
    schemaVersion: payload.schemaVersion,
    sessionId: payload.sessionId,
    files: payload.files,
  }
}

function shardSessionId(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return undefined
  return (payload as Record<string, unknown>).sessionId
}

function isManifestDoc(raw: unknown): raw is ManifestDoc {
  if (raw === null || typeof raw !== 'object') return false
  const doc = raw as Record<string, unknown>
  if (doc.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(doc.sessions)) return false
  return doc.sessions.every((s) => {
    if (s === null || typeof s !== 'object') return false
    const entry = s as Record<string, unknown>
    return typeof entry.sessionId === 'string' && typeof entry.bytes === 'number'
  })
}

function isLegacyShape(raw: unknown): raw is { schemaVersion: number; sessions: unknown[] } {
  if (raw === null || typeof raw !== 'object') return false
  const value = raw as Record<string, unknown>
  return typeof value.schemaVersion === 'number' && Array.isArray(value.sessions)
}

function describeLegacy(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return typeof raw
  const value = raw as Record<string, unknown>
  return `schemaVersion=${String(value.schemaVersion)}, sessions=${
    Array.isArray(value.sessions) ? value.sessions.length : 'not-an-array'
  }`
}

function validateLegacySessions(raw: readonly unknown[]): LegacySession[] | undefined {
  const sessions: LegacySession[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return undefined
    const value = entry as Record<string, unknown>
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return undefined
    if (!Array.isArray(value.files)) return undefined
    sessions.push({ sessionId: value.sessionId, files: value.files })
  }
  return sessions
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Test-only: how many buckets are still pinned by at least one window handle. */
export function _getSharedBucketCountForTests(): number {
  return sharedBuckets.size
}

export interface SessionChangesStoreMainServiceOptions {
  /** `<userData>` root; tests pass a temp directory. */
  readonly userDataDir: string
}

export class SessionChangesStoreMainService implements ISessionChangesStoreService, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _root: string
  private readonly _handles = new Map<string, Bucket>()
  /** One handle per bucket directory per window: re-opening the same workspace
   *  reuses its handle instead of pinning (and caching) the bucket again. */
  private readonly _handleByDir = new Map<string, string>()
  private readonly _logger: ILogger

  constructor(
    private readonly _storage: MainStorageService,
    private readonly _loggerService: ILoggerService,
    options: SessionChangesStoreMainServiceOptions,
  ) {
    this._root = join(options.userDataDir, 'session-changes')
    this._logger = _loggerService.createLogger({
      id: 'sessionChangesStore',
      name: 'Session Changes Store',
    })
  }

  async openBucket(): Promise<SessionChangesBucketInfo> {
    const workspaceId = this._storage.workspaceId
    const scope = workspaceId === null ? StorageScope.GLOBAL : StorageScope.WORKSPACE
    const legacyStorage =
      scope === StorageScope.WORKSPACE
        ? this._storage.workspaceStorage
        : this._storage.globalStorage
    if (legacyStorage === null) {
      throw new Error('workspace scope is bound but its storage backend is missing')
    }
    const dir = join(this._root, workspaceId ?? 'global')
    let handle = this._handleByDir.get(dir)
    if (handle === undefined) {
      let bucket = sharedBuckets.get(dir)
      if (!bucket) {
        bucket = new Bucket(dir, scope, workspaceId, legacyStorage, this._logger)
        sharedBuckets.set(dir, bucket)
      }
      handle = randomUUID()
      bucket.acquire()
      this._handles.set(handle, bucket)
      this._handleByDir.set(dir, handle)
    }
    const bucket = this._handles.get(handle)!
    const warning = await bucket.ready
    return {
      handle,
      scope,
      label: bucket.label,
      ...(warning !== undefined ? { importWarning: warning } : {}),
    }
  }

  private _bucket(handle: string): Bucket {
    const bucket = this._handles.get(handle)
    if (!bucket) throw new Error('unknown session changes bucket handle')
    return bucket
  }

  async list(handle: string): Promise<readonly SessionChangesShardMeta[]> {
    const bucket = this._bucket(handle)
    await bucket.ready
    return bucket.list()
  }

  async read(handle: string, sessionId: string): Promise<SessionChangesReadResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    return bucket._readShardFile(sessionId)
  }

  async write(
    handle: string,
    sessionId: string,
    payload: unknown,
  ): Promise<SessionChangesWriteResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (payload === null || typeof payload !== 'object') {
      return { ok: false, error: 'session change payload must be an object' }
    }
    if ((payload as Record<string, unknown>).sessionId !== sessionId) {
      return { ok: false, error: 'session change payload session id mismatch' }
    }
    return bucket.write(sessionId, payload)
  }

  async remove(handle: string, sessionId: string): Promise<void> {
    const bucket = this._bucket(handle)
    await bucket.ready
    await bucket.remove(sessionId)
  }

  async flush(handle: string): Promise<void> {
    const bucket = this._bucket(handle)
    await bucket.ready
    await bucket.flush()
  }

  async closeBucket(handle: string): Promise<void> {
    const bucket = this._handles.get(handle)
    if (!bucket) return
    this._handles.delete(handle)
    this._handleByDir.delete(bucket.dir)
    // Land whatever is still queued before the bucket's cache is dropped.
    await bucket.flush()
    this._releaseBucket(bucket)
  }

  private _releaseBucket(bucket: Bucket): void {
    if (!bucket.release()) return
    bucket.releaseCaches()
    if (sharedBuckets.get(bucket.dir) === bucket) sharedBuckets.delete(bucket.dir)
    migrationByDir.delete(bucket.dir)
  }

  /** Main-only: drain every bucket this window touched (window close / quit). */
  async flushAll(): Promise<void> {
    const buckets = new Set(this._handles.values())
    await Promise.all([...buckets].map((bucket) => bucket.flush()))
  }

  dispose(): void {
    // Synchronous backstop for window close / will-quit, which cannot await an
    // async drain. The tracker's own shutdown participant flushes first.
    const buckets = new Set(this._handles.values())
    for (const bucket of buckets) bucket.flushSync()
    // Releasing the last handle evicts the bucket, so no workspace this window
    // ever visited keeps its manifest/shard bodies cached in main.
    for (const bucket of buckets) this._releaseBucket(bucket)
    this._handles.clear()
    this._handleByDir.clear()
  }
}
