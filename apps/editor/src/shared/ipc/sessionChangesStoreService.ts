/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the per-session ACP change shard store.
 *
 *  The store keeps each session's persisted change records in its own file under
 *  `<userData>/session-changes/<bucket>/`. A bucket handle is issued by main when
 *  the renderer opens it and pins that bucket for the lifetime of the handle, so
 *  a workspace switch can never redirect an in-flight write into the new bucket.
 *  Handles are opaque; no renderer-supplied path ever reaches the filesystem.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type StorageScope } from '@universe-editor/platform'

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
  /** Serialized size of the shard, for diagnostics/budgets only. */
  readonly bytes: number
}

export type SessionChangesReadResult =
  | { readonly status: 'ok'; readonly payload: unknown }
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
  read(handle: string, sessionId: string): Promise<SessionChangesReadResult>
  write(handle: string, sessionId: string, payload: unknown): Promise<SessionChangesWriteResult>
  remove(handle: string, sessionId: string): Promise<void>
  /** Drain every pending shard/index write for this bucket. */
  flush(handle: string): Promise<void>
  /**
   * Release a handle. Dropping the last handle for a bucket lets main evict the
   * bucket's cached manifest/shard bodies; another window (or a retry queued
   * against a retired bucket) keeps the bucket alive through its own handle.
   */
  closeBucket(handle: string): Promise<void>
}

export const ISessionChangesStoreService = createDecorator<ISessionChangesStoreService>(
  'sessionChangesStoreService',
)
