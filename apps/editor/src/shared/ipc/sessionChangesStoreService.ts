/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the per-session ACP change shard store.
 *
 *  Storage layout v2 (one directory per session):
 *    <userData>/session-changes/<bucket>/sessions/<sha256(sessionId)[:32]>/
 *      index.json                 small: file metadata + pinned-baseline presence
 *      files/<sha256(key)[:32]>.<gen>.json       one file's hunk batches (no baseline)
 *      baselines/<sha256(key)[:32]>.<gen>.json   the pinned baseline text (written
 *                                                only when it changes, chunked over IPC)
 *
 *  Why: v1 kept baseline + batches in one shard and rewrote/shipped the whole
 *  session on every edit. Baselines are pinned once and can be megabytes, so
 *  that turned every keystroke-sized record into a multi-MB IPC frame. v2
 *  writes only the entries whose revision moved and only a baseline whose
 *  reference changed; the index is committed last and is the commit point.
 *
 *  Bodies are generation-named because an in-place overwrite would leave "old
 *  index + new body" on disk if the process died before `commitIndex`: every
 *  write lands a fresh file and the index only starts referencing it on commit,
 *  so a crash always reads the previous committed generation. Orphan bodies are
 *  collected by the next commit's GC.
 *
 *  A handle returned by `openBucket` pins a bucket. Writes made through it keep
 *  landing in that bucket even after the window switches workspace, so a tail
 *  write from the old workspace can never mutate the new one. Handles are
 *  opaque; no renderer-supplied path ever reaches the filesystem.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type StorageScope } from '@universe-editor/platform'

/** v2 on-disk schema version (index / file / baseline payloads). */
export const SESSION_CHANGES_SCHEMA_VERSION = 2

/**
 * Baseline text is split into chunks of this many UTF-16 code units before
 * crossing IPC. Kept below the design's 512K so even a chunk of 3-byte UTF-8
 * characters (plus JSON escaping) stays well under the 1MiB frame budget.
 */
export const SESSION_CHANGES_BASELINE_CHUNK_CHARS = 256 * 1024

/** Renderer groups changed file entries by serialized size before each call. */
export const SESSION_CHANGES_ENTRY_GROUP_BYTES = 512 * 1024

/**
 * Hard per-call entry count. Many empty batches serialize to almost nothing, so
 * grouping by bytes alone could exceed main's validator and make the write fail
 * forever; the renderer splits by this count as well.
 */
export const SESSION_CHANGES_MAX_ENTRIES_PER_CALL = 4096

/**
 * Hard per-session index size. Above this the renderer drops the first-touched
 * files (with a warning) instead of sending an index main would reject — an
 * over-limit index must never turn into a permanently failing write.
 */
export const SESSION_CHANGES_MAX_INDEX_ENTRIES = 100_000

/** Upper bound for one `writeBaseline` chunk, mirrored by main's validator. */
export const SESSION_CHANGES_MAX_BASELINE_CHARS = 8 * 1024 * 1024

export interface SessionChangesBucketInfo {
  /** Opaque, per-window capability for one bucket. Not a filesystem path. */
  readonly handle: string
  readonly scope: StorageScope
  /** Diagnostic label (e.g. `workspace:<id>` / `global`); never a path. */
  readonly label: string
  /**
   * Set when opening the bucket could not finish the one-time legacy import.
   * The legacy data is left untouched; the tracker must not treat this as an
   * empty bucket for destructive cleanup.
   */
  readonly importWarning?: string
}

/** Listing shape deliberately carries no session body. */
export interface SessionChangesShardMeta {
  readonly sessionId: string
  /** Serialized size of the session, for diagnostics/budgets only. */
  readonly bytes: number
  /**
   * Monotonic write counter from the manifest. Used by the renderer to decide
   * whether a reload against the same bucket can reuse its in-memory state
   * (another window's write bumps this even when the byte count happens to match).
   * Absent when the manifest is degraded (the `_scanShards` fallback); the
   * renderer then never reuses state and re-reads the shards.
   */
  readonly version?: number
}

/** Metadata for one tracked file; the index is small enough to send whole. */
export interface SessionChangesIndexEntry {
  /** Opaque path identity key (renderer-derived); main hashes it for filenames. */
  readonly key: string
  readonly path: string
  readonly batchCount: number
  readonly origin: 'agent' | 'watched'
  /** Generation of the committed body (`files/<hash>.<gen>.json`). */
  readonly gen: string
  /**
   * Pinned-baseline presence:
   *   `'text'`  → a baseline blob exists under baselines/,
   *   `'null'`  → the file was created during the session (baseline null),
   *   absent    → no baseline was ever obtained.
   */
  readonly baseline?: 'text' | 'null'
  /** Generation of the committed baseline; required when `baseline === 'text'`. */
  readonly baselineGen?: string
  readonly baselineSource?: 'reported' | 'git'
  readonly created?: boolean
  readonly ignored?: boolean
}

export interface SessionChangesEntryWrite {
  readonly key: string
  /** Body generation chosen by the renderer; a new one per write so the body
   *  cannot overwrite content the committed index still points at. */
  readonly gen: string
  readonly batches: readonly unknown[]
}

/** One body reference: the key plus the generation the index committed. */
export interface SessionChangesEntryRef {
  readonly key: string
  readonly gen: string
}

export interface SessionChangesBaselineChunk {
  readonly index: number
  readonly count: number
  readonly text: string
}

export type SessionChangesReadResult =
  | {
      readonly status: 'ok'
      readonly format: 'v1'
      /** v1 shard payload `{ schemaVersion, sessionId, files }`; parsed by renderer. */
      readonly payload: unknown
    }
  | {
      readonly status: 'ok'
      readonly format: 'v2'
      readonly schemaVersion: number
      readonly files: readonly SessionChangesIndexEntry[]
    }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: string }

export interface SessionChangesEntryRead {
  readonly key: string
  readonly batches: readonly unknown[]
}

export type SessionChangesEntriesReadResult =
  | { readonly status: 'ok'; readonly entries: readonly SessionChangesEntryRead[] }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: string }

export type SessionChangesBaselineReadResult =
  | {
      readonly status: 'ok'
      readonly index: number
      readonly count: number
      readonly text: string
    }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly error: string }

export type SessionChangesWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

export interface ISessionChangesStoreService {
  readonly _serviceBrand: undefined
  /** Bind (and, on first use, migrate) the bucket the window currently points at. */
  openBucket(): Promise<SessionChangesBucketInfo>
  /** Session ids in LRU order (oldest first), without bodies. */
  list(handle: string): Promise<readonly SessionChangesShardMeta[]>
  /** Read the small index (v2) or the legacy single-shard payload (v1). */
  read(handle: string, sessionId: string): Promise<SessionChangesReadResult>
  /** Read the hunk-batch bodies for `refs` (v2 only). */
  readEntries(
    handle: string,
    sessionId: string,
    refs: readonly SessionChangesEntryRef[],
  ): Promise<SessionChangesEntriesReadResult>
  /** Read one chunk of a pinned baseline (v2 only). */
  readBaseline(
    handle: string,
    sessionId: string,
    key: string,
    gen: string,
    chunkIndex: number,
  ): Promise<SessionChangesBaselineReadResult>
  /** Replace the hunk-batch body of one or more files. */
  writeEntries(
    handle: string,
    sessionId: string,
    entries: readonly SessionChangesEntryWrite[],
  ): Promise<SessionChangesWriteResult>
  /**
   * Write one baseline chunk. Main assembles chunks in memory and only lands
   * the blob on the last chunk; a new `index: 0`, a timeout, or a removal
   * discards a half-assembled baseline.
   */
  writeBaseline(
    handle: string,
    sessionId: string,
    key: string,
    gen: string,
    chunk: SessionChangesBaselineChunk,
  ): Promise<SessionChangesWriteResult>
  /**
   * Commit the session's index — the point at which the write becomes visible.
   * Main then deletes files/baselines the index no longer references and
   * updates the manifest.
   */
  commitIndex(
    handle: string,
    sessionId: string,
    files: readonly SessionChangesIndexEntry[],
  ): Promise<SessionChangesWriteResult>
  /** Remove both the v2 directory and any legacy v1 shard file. */
  remove(handle: string, sessionId: string): Promise<void>
  /** Drain every pending shard/index write for this bucket. */
  flush(handle: string): Promise<void>
  /**
   * Release a handle. Dropping the last handle for a bucket lets main evict the
   * bucket's cached manifest/body storages; another window (or a retry queued
   * against a retired bucket) keeps the bucket alive through its own handle.
   */
  closeBucket(handle: string): Promise<void>
}

export const ISessionChangesStoreService = createDecorator<ISessionChangesStoreService>(
  'sessionChangesStoreService',
)
