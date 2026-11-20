/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Main-process owner of the per-session ACP change shards.
 *
 *  Storage layout v2 — one directory per session:
 *    sessions/<sha256(sessionId)[:32]>/
 *      index.json                    file metadata + which files have a baseline
 *      files/<sha256(key)[:32]>.<gen>.json one file's hunk batches (no baseline)
 *      baselines/<sha256(key)[:32]>.<gen>.json  pinned baseline text (chunked over IPC)
 *
 *  The index is committed last and is the commit point: only after it lands does
 *  a session's new content become visible, so a failed/partial write (including
 *  a half-assembled baseline) leaves the previous committed state intact.
 *
 *  Bodies are generation-named rather than overwritten in place: an in-place
 *  write would leave "old index + new body" on disk if the process died before
 *  `commitIndex`, silently breaking the commit-point invariant. Every body write
 *  lands a fresh file; the index references it only on commit, so a crash always
 *  reads the previous committed generation. After the commit, every body the new
 *  index does not reference (and its `.tmp`/`.synctmp`/`.bak` sidecars) is
 *  deleted.
 *
 *  Why: v1 shipped the whole session — baseline included — on every edit. A
 *  pinned baseline is written once and never changes, so v2 lets the renderer
 *  send only the entries whose revision moved, keeping every IPC frame small.
 *
 *  v1 compatibility: `sessions/<sidHash>.json` is still read (returned as
 *  `format: 'v1'`); the renderer parses it, marks the session dirty, and the
 *  next commit writes v2 and deletes the v1 file. `remove` clears both.
 *
 *  A handle returned by `openBucket` pins a bucket. Writes made through it keep
 *  landing in that bucket even after the window switches workspace, which is
 *  exactly what stops a tail write from the old workspace mutating the new one.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, sep } from 'node:path'
import type { IDisposable, ILogger, ILoggerService } from '@universe-editor/platform'
import { StorageScope } from '@universe-editor/platform'
import { createStorage, type Storage } from '../../storage.js'
import {
  SESSION_CHANGES_BASELINE_CHUNK_CHARS,
  SESSION_CHANGES_MAX_BASELINE_CHARS,
  SESSION_CHANGES_MAX_ENTRIES_PER_CALL,
  SESSION_CHANGES_MAX_INDEX_ENTRIES,
  SESSION_CHANGES_SCHEMA_VERSION,
  type ISessionChangesStoreService,
  type SessionChangesBaselineChunk,
  type SessionChangesBaselineReadResult,
  type SessionChangesBucketInfo,
  type SessionChangesEntriesReadResult,
  type SessionChangesEntryRead,
  type SessionChangesEntryRef,
  type SessionChangesEntryWrite,
  type SessionChangesIndexEntry,
  type SessionChangesReadResult,
  type SessionChangesShardMeta,
  type SessionChangesWriteResult,
} from '../../../shared/ipc/sessionChangesStoreService.js'
import type { MainStorageService } from './storageMainService.js'

const LEGACY_KEY = 'acp.sessionChanges'
const MANIFEST_KEY = 'manifest'
const DATA_KEY = 'data'
const MANIFEST_SCHEMA_VERSION = 1
const SESSIONS_DIR = 'sessions'
const FILES_DIR = 'files'
const BASELINES_DIR = 'baselines'
const INDEX_FILE = 'index.json'
/** A half-assembled baseline is dropped after this long without the next chunk. */
const BASELINE_ASSEMBLY_TIMEOUT_MS = 60_000
/** Backstop against a single absurdly large entries call (see storage.ts). */
const MAX_ENTRY_CALL_BYTES = 16 * 1024 * 1024

interface ManifestEntry {
  readonly sessionId: string
  readonly bytes: number
  readonly version?: number
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

interface BaselineAssembly {
  readonly count: number
  readonly chunks: Array<string | undefined>
  nextIndex: number
  timer: ReturnType<typeof setTimeout> | undefined
}

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
  /** One `createStorage` per v2 payload file, so flush/flushSync can drain them. */
  readonly fileStorages = new Map<string, Storage>()
  /** In-progress baseline assemblies, keyed by `sessionHash/keyHash`. */
  readonly baselineAssemblies = new Map<string, BaselineAssembly>()
  /** Baseline text read for the current chunked read, keyed by file path. */
  private readonly baselineTextCache = new Map<
    string,
    { readonly text: string; readonly timer: NodeJS.Timeout }
  >()
  /** Total chars held by {@link baselineAssemblies}. */
  private _assemblyChars = 0
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
    this.fileStorages.clear()
    this._clearBaselineAssemblies()
    this._clearBaselineTextCache()
    this.manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, sessions: [] }
  }

  constructor(
    readonly dir: string,
    readonly scope: StorageScope,
    readonly workspaceId: string | null,
    readonly legacyStorage: Storage,
    readonly logger: ILogger,
    private readonly _maxBaselineAssemblies = DEFAULT_MAX_BASELINE_ASSEMBLIES,
    private readonly _maxBaselineAssemblyChars = DEFAULT_MAX_BASELINE_ASSEMBLY_CHARS,
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
    if (this.manifestUnavailable) return this._scanShards()
    const sessions = this.manifest.sessions.map((s) => ({
      sessionId: s.sessionId,
      bytes: s.bytes,
      ...(s.version !== undefined ? { version: s.version } : {}),
    }))
    // A crash between committing an index and writing the manifest leaves a
    // session directory that `list()` would otherwise never surface (and never
    // GC). Adopt it into the manifest so it stays visible and collectable.
    for (const discovered of await this._discoverUnlistedSessions()) {
      sessions.push({ sessionId: discovered.sessionId, bytes: discovered.bytes, version: 0 })
      try {
        await this._setManifestEntry(discovered.sessionId, discovered.bytes, 0)
      } catch (err) {
        this.logger.warn(
          `failed to repair session changes manifest for ${discovered.sessionId}: ${(err as Error).message}`,
        )
      }
    }
    return sessions
  }

  /** v2 session directories with an index but no manifest entry. */
  private async _discoverUnlistedSessions(): Promise<
    readonly { readonly sessionId: string; readonly bytes: number }[]
  > {
    let names: string[]
    try {
      names = await fs.readdir(join(this.dir, SESSIONS_DIR))
    } catch {
      return []
    }
    const known = new Set(this.manifest.sessions.map((s) => s.sessionId))
    const knownDirs = new Set(this.manifest.sessions.map((s) => hashKey(s.sessionId)))
    const discovered: { sessionId: string; bytes: number }[] = []
    for (const name of names) {
      if (!/^[0-9a-f]{32}$/.test(name)) continue
      // A manifest entry already covers this directory; do not read its index
      // (a same-bucket reload must stay read-free for unchanged sessions).
      if (knownDirs.has(name)) continue
      const sessionDir = join(this.dir, SESSIONS_DIR, name)
      const read = await readJsonFile(join(sessionDir, INDEX_FILE))
      if (read.status !== 'ok') continue
      const index = indexDoc(read.value)
      if (index === undefined || known.has(index.sessionId)) continue
      known.add(index.sessionId)
      knownDirs.add(name)
      discovered.push({
        sessionId: index.sessionId,
        bytes: await this._measureSessionDir(sessionDir, index.files),
      })
    }
    return discovered
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
      if (name.endsWith('.json')) {
        const file = join(this.dir, SESSIONS_DIR, name)
        const read = await readJsonFile(file)
        if (read.status !== 'ok') continue
        const payload = shardPayload(read.value)
        if (payload === undefined || typeof payload.sessionId !== 'string') continue
        metas.push({
          sessionId: payload.sessionId,
          bytes: jsonSize(payload),
          mtime: await mtimeOf(file),
        })
        continue
      }
      // A v2 session directory.
      const indexPath = join(this.dir, SESSIONS_DIR, name, INDEX_FILE)
      const read = await readJsonFile(indexPath)
      if (read.status !== 'ok') continue
      const index = indexDoc(read.value)
      if (index === undefined) continue
      metas.push({
        sessionId: index.sessionId,
        bytes: await this._measureSessionDir(join(this.dir, SESSIONS_DIR, name), index.files),
        mtime: await mtimeOf(indexPath),
      })
    }
    metas.sort((a, b) => a.mtime - b.mtime)
    return metas.map(({ sessionId, bytes }) => ({ sessionId, bytes }))
  }

  private async _measureSessionDir(
    sessionDir: string,
    files: readonly SessionChangesIndexEntry[],
  ): Promise<number> {
    let bytes = await sizeOf(join(sessionDir, INDEX_FILE))
    for (const file of files) {
      bytes += await sizeOf(join(sessionDir, FILES_DIR, `${hashKey(file.key)}.${file.gen}.json`))
      if (file.baseline === 'text') {
        bytes += await sizeOf(
          join(sessionDir, BASELINES_DIR, `${hashKey(file.key)}.${file.baselineGen}.json`),
        )
      }
    }
    return bytes
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
        const file = this.v1ShardPath(session.sessionId)
        // A shard file without a manifest entry is data a previous partial
        // import (or a newer writer) already committed. Adopt it rather than
        // overwriting it with the older legacy copy.
        const current = await readJsonFile(file)
        if (current.status === 'ok') {
          const read = shardPayload(current.value)
          if (read === undefined || read.sessionId !== session.sessionId) {
            throw new Error(`existing shard ${session.sessionId} is unreadable`)
          }
          await this._appendManifest(session.sessionId, jsonSize(read), 0)
          await yieldToEventLoop()
          continue
        }
        if (current.status === 'error') {
          throw new Error(`existing shard ${session.sessionId} is unreadable: ${current.error}`)
        }
        // A v2 directory already committed by a newer writer is adopted as-is.
        const v2Index = await readJsonFile(this.indexPath(session.sessionId))
        if (v2Index.status === 'ok') {
          const index = indexDoc(v2Index.value)
          if (index !== undefined && index.sessionId === session.sessionId) {
            await this._appendManifest(
              session.sessionId,
              await this._measureSessionDir(this.sessionDir(session.sessionId), index.files),
              1,
            )
            await yieldToEventLoop()
            continue
          }
        }
        await this._writeV1ShardFile(session.sessionId, payload)
        const verify = await this._readV1ShardFile(session.sessionId)
        if (
          verify.status !== 'ok' ||
          verify.format !== 'v1' ||
          shardSessionId(verify.payload) !== session.sessionId
        ) {
          throw new Error(`verification failed for session ${session.sessionId}`)
        }
        await this._appendManifest(session.sessionId, jsonSize(payload), 0)
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

  private async _appendManifest(sessionId: string, bytes: number, version: number): Promise<void> {
    await this._setManifestEntry(sessionId, bytes, version)
  }

  private async _setManifestEntry(
    sessionId: string,
    bytes: number,
    version: number,
  ): Promise<void> {
    const sessions = this.manifest.sessions.filter((s) => s.sessionId !== sessionId)
    sessions.push({ sessionId, bytes, version })
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

  // -- paths -----------------------------------------------------------

  v1ShardPath(sessionId: string): string {
    return join(this.dir, SESSIONS_DIR, `${hashKey(sessionId)}.json`)
  }

  sessionDir(sessionId: string): string {
    return join(this.dir, SESSIONS_DIR, hashKey(sessionId))
  }

  indexPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), INDEX_FILE)
  }

  entryPath(sessionId: string, key: string, gen: string): string {
    return join(this.sessionDir(sessionId), FILES_DIR, `${hashKey(key)}.${gen}.json`)
  }

  baselinePath(sessionId: string, key: string, gen: string): string {
    return join(this.sessionDir(sessionId), BASELINES_DIR, `${hashKey(key)}.${gen}.json`)
  }

  // -- v1 shards -------------------------------------------------------

  async _writeV1ShardFile(sessionId: string, payload: unknown): Promise<void> {
    await this._storageFor(this.v1ShardPath(sessionId)).set(DATA_KEY, payload)
  }

  async _readV1ShardFile(sessionId: string): Promise<SessionChangesReadResult> {
    const read = await readJsonFile(this.v1ShardPath(sessionId))
    if (read.status === 'missing') return { status: 'missing' }
    if (read.status === 'error') return { status: 'error', error: read.error }
    const payload = shardPayload(read.value)
    if (payload === undefined) return { status: 'error', error: 'unrecognized shard shape' }
    if (payload.sessionId !== sessionId) {
      return { status: 'error', error: 'shard session id mismatch' }
    }
    return { status: 'ok', format: 'v1', payload }
  }

  // -- v2 reads --------------------------------------------------------

  async read(sessionId: string): Promise<SessionChangesReadResult> {
    const indexRead = await readJsonFile(this.indexPath(sessionId))
    if (indexRead.status === 'ok') {
      const index = indexDoc(indexRead.value)
      if (index === undefined) return { status: 'error', error: 'unrecognized index shape' }
      if (index.sessionId !== sessionId) {
        return { status: 'error', error: 'index session id mismatch' }
      }
      return {
        status: 'ok',
        format: 'v2',
        schemaVersion: index.schemaVersion,
        files: index.files,
      }
    }
    if (indexRead.status === 'error') {
      return { status: 'error', error: indexRead.error }
    }
    return this._readV1ShardFile(sessionId)
  }

  async readEntries(
    sessionId: string,
    refs: readonly SessionChangesEntryRef[],
  ): Promise<SessionChangesEntriesReadResult> {
    const entries: SessionChangesEntryRead[] = []
    for (const ref of refs) {
      const read = await readJsonFile(this.entryPath(sessionId, ref.key, ref.gen))
      if (read.status === 'missing') {
        return { status: 'error', error: `missing entry ${ref.key}` }
      }
      if (read.status === 'error') return { status: 'error', error: read.error }
      const payload = read.value
      const batches =
        payload !== null && typeof payload === 'object'
          ? (payload as Record<string, unknown>)[DATA_KEY]
          : undefined
      const body =
        batches !== null && typeof batches === 'object'
          ? (batches as Record<string, unknown>)['batches']
          : undefined
      if (!Array.isArray(body)) {
        return { status: 'error', error: `unrecognized entry shape ${ref.key}` }
      }
      entries.push({ key: ref.key, batches: body })
    }
    return { status: 'ok', entries }
  }

  async readBaseline(
    sessionId: string,
    key: string,
    gen: string,
    chunkIndex: number,
  ): Promise<SessionChangesBaselineReadResult> {
    const path = this.baselinePath(sessionId, key, gen)
    let text = this.baselineTextCache.get(path)?.text
    if (text === undefined) {
      const read = await readJsonFile(path)
      if (read.status === 'missing') return { status: 'missing' }
      if (read.status === 'error') return { status: 'error', error: read.error }
      const value =
        read.value !== null && typeof read.value === 'object'
          ? (read.value as Record<string, unknown>)[DATA_KEY]
          : undefined
      if (typeof value !== 'string') {
        return { status: 'error', error: 'unrecognized baseline shape' }
      }
      text = value
      // The renderer reads chunks sequentially; one disk read serves the rest of
      // this load. A dropped connection is bounded by the timeout.
      const timer = setTimeout(() => this._dropBaselineText(path), BASELINE_READ_CACHE_MS)
      timer.unref?.()
      this.baselineTextCache.set(path, { text, timer })
    }
    const count = baselineChunkCount(text.length)
    if (chunkIndex < 0 || chunkIndex >= count) {
      return { status: 'error', error: `baseline chunk ${chunkIndex} out of range (${count})` }
    }
    if (chunkIndex === count - 1) this._dropBaselineText(path)
    return {
      status: 'ok',
      index: chunkIndex,
      count,
      text: text.slice(
        chunkIndex * SESSION_CHANGES_BASELINE_CHUNK_CHARS,
        (chunkIndex + 1) * SESSION_CHANGES_BASELINE_CHUNK_CHARS,
      ),
    }
  }

  private _dropBaselineText(path: string): void {
    const cached = this.baselineTextCache.get(path)
    if (cached === undefined) return
    clearTimeout(cached.timer)
    this.baselineTextCache.delete(path)
  }

  private _clearBaselineTextCache(): void {
    for (const path of [...this.baselineTextCache.keys()]) this._dropBaselineText(path)
  }

  // -- v2 writes -------------------------------------------------------

  async writeEntries(
    sessionId: string,
    entries: readonly SessionChangesEntryWrite[],
  ): Promise<SessionChangesWriteResult> {
    return this.enqueue(async () => {
      try {
        for (const entry of entries) {
          await this._storageFor(this.entryPath(sessionId, entry.key, entry.gen)).set(DATA_KEY, {
            batches: entry.batches,
          })
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  async writeBaseline(
    sessionId: string,
    key: string,
    gen: string,
    chunk: SessionChangesBaselineChunk,
  ): Promise<SessionChangesWriteResult> {
    return this.enqueue(async () => {
      const id = `${hashKey(sessionId)}/${hashKey(key)}`
      if (chunk.index === 0) {
        this._discardBaselineAssembly(id)
        if (this.baselineAssemblies.size >= this._maxBaselineAssemblies) {
          return { ok: false, error: 'too many baseline assemblies in flight; retry later' }
        }
        if (this._assemblyChars + chunk.text.length > this._maxBaselineAssemblyChars) {
          return { ok: false, error: 'baseline assembly buffer is full; retry later' }
        }
        const assembly: BaselineAssembly = {
          count: chunk.count,
          chunks: new Array<string | undefined>(chunk.count),
          nextIndex: 0,
          timer: undefined,
        }
        assembly.timer = setTimeout(() => {
          this._discardBaselineAssembly(id)
        }, BASELINE_ASSEMBLY_TIMEOUT_MS)
        assembly.timer.unref?.()
        this.baselineAssemblies.set(id, assembly)
      }
      const assembly = this.baselineAssemblies.get(id)
      if (assembly === undefined) {
        return { ok: false, error: 'baseline assembly was discarded; restart from chunk 0' }
      }
      if (assembly.count !== chunk.count || assembly.nextIndex !== chunk.index) {
        this._discardBaselineAssembly(id)
        return { ok: false, error: 'baseline chunks arrived out of order; restart from chunk 0' }
      }
      if (this._assemblyChars + chunk.text.length > this._maxBaselineAssemblyChars) {
        return { ok: false, error: 'baseline assembly buffer is full; retry later' }
      }
      assembly.chunks[chunk.index] = chunk.text
      this._assemblyChars += chunk.text.length
      assembly.nextIndex = chunk.index + 1
      if (chunk.index !== chunk.count - 1) return { ok: true }

      this._discardBaselineAssembly(id)
      const missing = assembly.chunks.findIndex((part) => part === undefined)
      if (missing >= 0) {
        return { ok: false, error: `baseline chunk ${missing} is missing; restart from chunk 0` }
      }
      const text = assembly.chunks.join('')
      if (text.length > SESSION_CHANGES_MAX_BASELINE_CHARS) {
        return { ok: false, error: 'baseline exceeds the maximum size' }
      }
      try {
        const path = this.baselinePath(sessionId, key, gen)
        this._dropBaselineText(path)
        await this._storageFor(path).set(DATA_KEY, text)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  async commitIndex(
    sessionId: string,
    files: readonly SessionChangesIndexEntry[],
  ): Promise<SessionChangesWriteResult> {
    return this.enqueue(async () => {
      try {
        await this._storageFor(this.indexPath(sessionId)).set(DATA_KEY, {
          schemaVersion: SESSION_CHANGES_SCHEMA_VERSION,
          sessionId,
          files,
        })
        // The index is the commit point: from here on the new content is
        // visible, so a GC failure only leaves orphan files (harmless) and
        // must not fail the write.
        await this._collectGarbage(sessionId, files)
        const bytes = await this._measureSessionDir(this.sessionDir(sessionId), files)
        const version =
          (this.manifest.sessions.find((s) => s.sessionId === sessionId)?.version ?? 0) + 1
        await this._setManifestEntry(sessionId, bytes, version)
        // A v1 shard is superseded once v2 is committed.
        await this._removeFile(this.v1ShardPath(sessionId))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  private async _collectGarbage(
    sessionId: string,
    files: readonly SessionChangesIndexEntry[],
  ): Promise<void> {
    const referenced = new Set(files.map((file) => `${hashKey(file.key)}.${file.gen}.json`))
    const baselines = new Set(
      files
        .filter((file) => file.baseline === 'text')
        .map((file) => `${hashKey(file.key)}.${file.baselineGen}.json`),
    )
    await this._collectDir(join(this.sessionDir(sessionId), FILES_DIR), referenced)
    await this._collectDir(join(this.sessionDir(sessionId), BASELINES_DIR), baselines)
  }

  private async _collectDir(dir: string, referenced: ReadonlySet<string>): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (referenced.has(name)) continue
      await this._removeFile(join(dir, name))
    }
  }

  private _clearBaselineAssemblies(): void {
    for (const id of [...this.baselineAssemblies.keys()]) this._discardBaselineAssembly(id)
  }

  private _discardBaselineAssembly(id: string): void {
    const assembly = this.baselineAssemblies.get(id)
    if (assembly === undefined) return
    if (assembly.timer !== undefined) clearTimeout(assembly.timer)
    for (const chunk of assembly.chunks) {
      if (chunk !== undefined) this._assemblyChars -= chunk.length
    }
    this.baselineAssemblies.delete(id)
  }

  // -- removal / flush --------------------------------------------------

  async remove(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const sessionHash = hashKey(sessionId)
      for (const id of [...this.baselineAssemblies.keys()]) {
        if (id.startsWith(`${sessionHash}/`)) this._discardBaselineAssembly(id)
      }
      const sessionDir = this.sessionDir(sessionId)
      for (const path of [...this.baselineTextCache.keys()]) {
        if (path.startsWith(sessionDir)) this._dropBaselineText(path)
      }
      await this._removeFile(this.v1ShardPath(sessionId))
      await this._removeDir(sessionDir)
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

  private async _removeFile(path: string): Promise<void> {
    const storage = this.fileStorages.get(path)
    if (storage) {
      try {
        await storage.flush()
      } catch {
        // best-effort; removal below removes every file the backend uses
      }
      this.fileStorages.delete(path)
    }
    for (const candidate of [path, `${path}.tmp`, `${path}.synctmp`, `${path}.bak`]) {
      try {
        await fs.rm(candidate, { force: true })
      } catch {
        // best-effort
      }
    }
  }

  private async _removeDir(dir: string): Promise<void> {
    for (const [path, storage] of [...this.fileStorages]) {
      if (!path.startsWith(`${dir}${sep}`)) continue
      try {
        await storage.flush()
      } catch {
        // best-effort
      }
      this.fileStorages.delete(path)
    }
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    // createStorage's sidecars sit next to the directory, not inside it.
    for (const candidate of [`${dir}.tmp`, `${dir}.synctmp`, `${dir}.bak`]) {
      try {
        await fs.rm(candidate, { force: true })
      } catch {
        // best-effort
      }
    }
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      await this.manifestStorage.flush()
      for (const storage of this.fileStorages.values()) await storage.flush()
    })
  }

  flushSync(): void {
    try {
      this.manifestStorage.flushSync()
    } catch {
      // best-effort
    }
    for (const storage of this.fileStorages.values()) {
      try {
        storage.flushSync()
      } catch {
        // best-effort
      }
    }
  }

  private _storageFor(path: string): Storage {
    let storage = this.fileStorages.get(path)
    if (!storage) {
      storage = createStorage(path)
      this.fileStorages.set(path, storage)
    }
    return storage
  }
}

function baselineChunkCount(chars: number): number {
  return Math.max(1, Math.ceil(chars / SESSION_CHANGES_BASELINE_CHUNK_CHARS))
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

async function mtimeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return 0
  }
}

async function readJsonFile(file: string): Promise<JsonReadResult> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'error', error: (err as Error).message }
    }
    // `createStorage` rotates the previous file to `.bak` before renaming the
    // temp into place, so a crash between the two renames leaves only the
    // `.bak`. Read it the way `createStorage` does instead of reporting the
    // committed session as missing.
    try {
      text = await fs.readFile(`${file}.bak`, 'utf8')
    } catch (bakErr) {
      if ((bakErr as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      return { status: 'error', error: (bakErr as Error).message }
    }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch (err) {
    return { status: 'error', error: `unparseable json: ${(err as Error).message}` }
  }
}

/** A v1 shard file is `{ data: { schemaVersion, sessionId, files } }`. */
function shardPayload(
  raw: unknown,
): { schemaVersion: number; sessionId: unknown; files: unknown } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = (raw as Record<string, unknown>)[DATA_KEY]
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

/** A v2 index file is `{ data: { schemaVersion, sessionId, files } }`. */
function indexDoc(
  raw: unknown,
): { schemaVersion: number; sessionId: string; files: SessionChangesIndexEntry[] } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = (raw as Record<string, unknown>)[DATA_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const doc = value as Record<string, unknown>
  if (doc.schemaVersion !== SESSION_CHANGES_SCHEMA_VERSION) return undefined
  if (typeof doc.sessionId !== 'string') return undefined
  if (!Array.isArray(doc.files)) return undefined
  for (const entry of doc.files) {
    if (entry === null || typeof entry !== 'object') return undefined
    const file = entry as Record<string, unknown>
    if (typeof file.key !== 'string' || typeof file.path !== 'string') return undefined
    if (typeof file.batchCount !== 'number') return undefined
    if (file.origin !== 'agent' && file.origin !== 'watched') return undefined
    // Generation names a path segment; an unvalidated value is a path injection.
    if (!validGen(file.gen)) return undefined
    if (file.baseline === 'text') {
      if (!validGen(file.baselineGen)) return undefined
    } else if (file.baselineGen !== undefined && !validGen(file.baselineGen)) {
      return undefined
    }
  }
  return {
    schemaVersion: doc.schemaVersion,
    sessionId: doc.sessionId,
    files: doc.files as SessionChangesIndexEntry[],
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
    return (
      typeof entry.sessionId === 'string' &&
      typeof entry.bytes === 'number' &&
      (entry.version === undefined || typeof entry.version === 'number')
    )
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

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

const MAX_ID_CHARS = 1024
const MAX_KEY_CHARS = 8192
/** Body generations become part of a filename, so main only accepts this shape. */
const GEN_PATTERN = /^[0-9a-z]{1,32}$/

function validGen(value: unknown): value is string {
  return typeof value === 'string' && GEN_PATTERN.test(value)
}

function validSessionId(value: unknown): value is string {
  return isNonEmptyString(value, MAX_ID_CHARS) && !value.includes('\0')
}

function validKey(value: unknown): value is string {
  return isNonEmptyString(value, MAX_KEY_CHARS) && !value.includes('\0')
}

/** Test-only: how many buckets are still pinned by at least one window handle. */
export function _getSharedBucketCountForTests(): number {
  return sharedBuckets.size
}

export interface SessionChangesStoreMainServiceOptions {
  /** `<userData>` root; tests pass a temp directory. */
  readonly userDataDir: string
  /** In-flight baseline assemblies allowed per bucket (default 8). */
  readonly maxBaselineAssemblies?: number
  /** Total UTF-16 chars buffered across in-flight baseline assemblies (default 32Mi). */
  readonly maxBaselineAssemblyChars?: number
}

const DEFAULT_MAX_BASELINE_ASSEMBLIES = 8
const DEFAULT_MAX_BASELINE_ASSEMBLY_CHARS = 32 * 1024 * 1024
/** How long a fully-read baseline text stays cached for the remaining chunks. */
const BASELINE_READ_CACHE_MS = 60_000

export class SessionChangesStoreMainService implements ISessionChangesStoreService, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _root: string
  private readonly _handles = new Map<string, Bucket>()
  /** One handle per bucket directory per window: re-opening the same workspace
   *  reuses its handle instead of pinning (and caching) the bucket again. */
  private readonly _handleByDir = new Map<string, string>()
  private readonly _logger: ILogger
  private readonly _options: SessionChangesStoreMainServiceOptions

  constructor(
    private readonly _storage: MainStorageService,
    private readonly _loggerService: ILoggerService,
    options: SessionChangesStoreMainServiceOptions,
  ) {
    this._options = options
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
        bucket = new Bucket(
          dir,
          scope,
          workspaceId,
          legacyStorage,
          this._logger,
          this._options.maxBaselineAssemblies,
          this._options.maxBaselineAssemblyChars,
        )
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
    if (!validSessionId(sessionId)) return { status: 'error', error: 'invalid session id' }
    return bucket.read(sessionId)
  }

  async readEntries(
    handle: string,
    sessionId: string,
    refs: readonly SessionChangesEntryRef[],
  ): Promise<SessionChangesEntriesReadResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) return { status: 'error', error: 'invalid session id' }
    if (
      !Array.isArray(refs) ||
      !refs.every(
        (ref) => ref !== null && typeof ref === 'object' && validKey(ref.key) && validGen(ref.gen),
      )
    ) {
      return { status: 'error', error: 'invalid entry keys' }
    }
    if (refs.length > SESSION_CHANGES_MAX_INDEX_ENTRIES) {
      return { status: 'error', error: 'too many entry keys' }
    }
    return bucket.readEntries(sessionId, refs)
  }

  async readBaseline(
    handle: string,
    sessionId: string,
    key: string,
    gen: string,
    chunkIndex: number,
  ): Promise<SessionChangesBaselineReadResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) return { status: 'error', error: 'invalid session id' }
    if (!validKey(key)) return { status: 'error', error: 'invalid entry key' }
    if (!validGen(gen)) return { status: 'error', error: 'invalid entry gen' }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return { status: 'error', error: 'invalid baseline chunk index' }
    }
    return bucket.readBaseline(sessionId, key, gen, chunkIndex)
  }

  async writeEntries(
    handle: string,
    sessionId: string,
    entries: readonly SessionChangesEntryWrite[],
  ): Promise<SessionChangesWriteResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) {
      return { ok: false, error: 'invalid session id' }
    }
    if (!Array.isArray(entries) || entries.length > SESSION_CHANGES_MAX_ENTRIES_PER_CALL) {
      return { ok: false, error: 'invalid entry list' }
    }
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        return { ok: false, error: 'entry must be an object' }
      }
      if (!validKey(entry.key)) return { ok: false, error: 'invalid entry key' }
      if (!validGen(entry.gen)) return { ok: false, error: 'invalid entry gen' }
      if (!Array.isArray(entry.batches))
        return { ok: false, error: 'entry batches must be an array' }
    }
    if (jsonSize(entries) > MAX_ENTRY_CALL_BYTES) {
      return { ok: false, error: 'entry payload exceeds the maximum size' }
    }
    return bucket.writeEntries(sessionId, entries)
  }

  async writeBaseline(
    handle: string,
    sessionId: string,
    key: string,
    gen: string,
    chunk: SessionChangesBaselineChunk,
  ): Promise<SessionChangesWriteResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) {
      return { ok: false, error: 'invalid session id' }
    }
    if (!validKey(key)) return { ok: false, error: 'invalid entry key' }
    if (!validGen(gen)) return { ok: false, error: 'invalid entry gen' }
    if (chunk === null || typeof chunk !== 'object') {
      return { ok: false, error: 'baseline chunk must be an object' }
    }
    const { index, count, text } = chunk
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > baselineChunkCount(SESSION_CHANGES_MAX_BASELINE_CHARS)
    ) {
      return { ok: false, error: 'invalid baseline chunk count' }
    }
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      return { ok: false, error: 'invalid baseline chunk index' }
    }
    if (typeof text !== 'string' || text.length > SESSION_CHANGES_BASELINE_CHUNK_CHARS) {
      return { ok: false, error: 'invalid baseline chunk text' }
    }
    return bucket.writeBaseline(sessionId, key, gen, chunk)
  }

  async commitIndex(
    handle: string,
    sessionId: string,
    files: readonly SessionChangesIndexEntry[],
  ): Promise<SessionChangesWriteResult> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) {
      return { ok: false, error: 'invalid session id' }
    }
    if (!Array.isArray(files) || files.length > SESSION_CHANGES_MAX_INDEX_ENTRIES) {
      return { ok: false, error: 'invalid index file list' }
    }
    const keys = new Set<string>()
    for (const file of files) {
      if (file === null || typeof file !== 'object') {
        return { ok: false, error: 'index entry must be an object' }
      }
      if (!validKey(file.key)) return { ok: false, error: 'invalid index entry key' }
      if (keys.has(file.key)) return { ok: false, error: 'duplicate index entry key' }
      keys.add(file.key)
      if (typeof file.path !== 'string' || file.path.length > MAX_KEY_CHARS * 4) {
        return { ok: false, error: 'invalid index entry path' }
      }
      if (!Number.isInteger(file.batchCount) || file.batchCount < 0) {
        return { ok: false, error: 'invalid index entry batch count' }
      }
      if (file.origin !== 'agent' && file.origin !== 'watched') {
        return { ok: false, error: 'invalid index entry origin' }
      }
      if (!validGen(file.gen)) {
        return { ok: false, error: 'invalid index entry gen' }
      }
      if (file.baseline !== undefined && file.baseline !== 'text' && file.baseline !== 'null') {
        return { ok: false, error: 'invalid index entry baseline kind' }
      }
      if (
        file.baselineGen !== undefined &&
        (!validGen(file.baselineGen) || file.baseline !== 'text')
      ) {
        return { ok: false, error: 'invalid index entry baseline gen' }
      }
      if (file.baseline === 'text' && file.baselineGen === undefined) {
        return { ok: false, error: 'missing index entry baseline gen' }
      }
      if (
        file.baselineSource !== undefined &&
        file.baselineSource !== 'reported' &&
        file.baselineSource !== 'git'
      ) {
        return { ok: false, error: 'invalid index entry baseline source' }
      }
    }
    return bucket.commitIndex(sessionId, files)
  }

  async remove(handle: string, sessionId: string): Promise<void> {
    const bucket = this._bucket(handle)
    await bucket.ready
    if (!validSessionId(sessionId)) return
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
