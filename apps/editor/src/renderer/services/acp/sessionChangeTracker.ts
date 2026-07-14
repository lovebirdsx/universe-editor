/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangeTrackerService — per-session, whole-file change tracking.
 *
 *  Agent adapters report each file edit as hunk batches normalized by
 *  AcpSession (Claude `structuredPatch`, Codex ACP diff content). We accumulate
 *  those hunks per (sessionId, path) in apply-order. To render a *whole-file*
 *  diff scoped to the session, we read the file's current on-disk content and run
 *  {@link reconstructBaseline} in reverse to recover the pre-session baseline —
 *  the agent writes directly to disk, so the renderer can never read the real
 *  pre-edit content otherwise.
 *
 *  Only the hunk batches are persisted (workspace-first via PersistedStateBase);
 *  baseline and current are always recomputed from disk so the store stays small
 *  and survives editor restarts / session resume.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  observableValue,
  registerSingleton,
  InstantiationType,
  URI,
  IFileService,
  IStorageService,
  IWorkspaceService,
  ITelemetryService,
  ILoggerService,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from './persistedStateBase.js'
import { reconstructBaseline, type DiffBatch, type DiffHunk } from './diff/reconstructBaseline.js'

export type SessionFileChangeStatus = 'added' | 'modified' | 'deleted' | 'degraded'

export interface SessionFileChange {
  readonly uri: URI
  readonly path: string
  readonly baseline: string
  readonly current: string
  readonly status: SessionFileChangeStatus
  /** Number of tool-call batches that touched this file. */
  readonly batchCount: number
}

export interface ISessionChangeTrackerService {
  readonly _serviceBrand: undefined
  /** Idempotent; main.tsx fire-and-forgets. */
  initialize(): Promise<void>
  /**
   * Record one Edit/Write tool call's hunks against a file. Re-delivered updates
   * for the same `toolCallId` replace the prior batch rather than duplicating.
   * `created` marks a Write that created the file (forces `added` even with no
   * hunks, e.g. an empty-content Write).
   */
  record(
    sessionId: string,
    path: string,
    toolCallId: string,
    hunks: readonly DiffHunk[],
    created?: boolean,
  ): void
  /** Observable list of whole-file changes for a session (empty if none/unknown). */
  changesFor(sessionId: string): IObservable<readonly SessionFileChange[]>
  /** Drop all tracked changes for a session (e.g. on user-initiated clear). */
  clear(sessionId: string): void
  /**
   * Preview the file impact of un-applying the batches whose tool call ids are in
   * `toolCallIds` (a rewind's post-anchor edits). Does not touch disk. Returns
   * the affected files and aggregate line stats, shaped for the rewind confirm
   * dialog. Used for the codex rewind path where the agent can't roll files back.
   */
  previewRestore(sessionId: string, toolCallIds: readonly string[]): Promise<RewindFileImpact>
  /**
   * Un-apply the batches in `toolCallIds` from the current on-disk content and
   * write the reverted files back, rolling those files to their state at the
   * rewind anchor. Also drops those batches from tracking so session diff stays
   * accurate. Returns the same impact shape as {@link previewRestore}.
   */
  restore(sessionId: string, toolCallIds: readonly string[]): Promise<RewindFileImpact>
}

/** Aggregate impact of a rewind file rollback (mirrors the agent RewindFilesResult fields). */
export interface RewindFileImpact {
  readonly filesChanged: readonly string[]
  readonly insertions: number
  readonly deletions: number
}

export const ISessionChangeTrackerService = createDecorator<ISessionChangeTrackerService>(
  'sessionChangeTrackerService',
)

const STORAGE_KEY = 'acp.sessionChanges'
const SCHEMA_VERSION = 2

/**
 * Throttle window for `record`-driven recomputes. An agent can push hundreds of
 * edit tool-calls within a few seconds; without coalescing, each one would
 * re-read every tracked file (O(edits × files)) and exhaust file handles
 * (`EMFILE`), crashing the editor. Recomputes collapse to at most one per window.
 */
const RECOMPUTE_THROTTLE_MS = 150

/** Max concurrent file reads inside a single recompute — caps open handles so a
 *  session tracking hundreds of files can never trigger `EMFILE`. */
const RECOMPUTE_READ_CONCURRENCY = 8

/** Map `items` through `fn` with a bounded number of in-flight calls. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Per-file tracking record: accumulated hunk batches. */
interface FileRecord {
  batches: DiffBatch[]
}

/** Tracker state keyed by sessionId → path → record. */
type TrackerState = Map<string, Map<string, FileRecord>>

interface PersistedShape {
  readonly schemaVersion: number
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string
    readonly files: ReadonlyArray<{
      readonly path: string
      readonly batches: readonly DiffBatch[]
    }>
  }>
}

/** Canonicalize a file path so agent-reported paths and fs-watch paths key the
 *  same record (e.g. Windows drive-letter casing). Non-file URIs pass through. */
function normalizePath(path: string): string {
  return path.includes('://') ? path : URI.file(path).fsPath
}

export class SessionChangeTrackerService
  extends PersistedStateBase<TrackerState>
  implements ISessionChangeTrackerService
{
  declare readonly _serviceBrand: undefined

  /** Per-session observable lists, lazily created on first access. */
  private readonly _observables = new Map<
    string,
    ISettableObservable<readonly SessionFileChange[]>
  >()

  /** Sessions with a recompute pending inside the current throttle window. */
  private readonly _pendingRecompute = new Map<string, ReturnType<typeof setTimeout>>()

  /** Throttle window between a `record` and its recompute. Overridable in tests
   *  (set to 0 for a synchronous flush). */
  recomputeThrottleMs = RECOMPUTE_THROTTLE_MS

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _files: IFileService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpSessionChanges',
      loggerName: 'ACP Session Changes',
      persistFailureEvent: 'acp.session_changes_persist_failed',
    })
  }

  override dispose(): void {
    for (const timer of this._pendingRecompute.values()) clearTimeout(timer)
    this._pendingRecompute.clear()
    super.dispose()
  }

  // -- PersistedStateBase hooks ---------------------------------------

  protected _emptyState(): TrackerState {
    return new Map()
  }

  protected _serialize(state: TrackerState): PersistedShape {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessions: [...state.entries()].map(([sessionId, files]) => ({
        sessionId,
        files: [...files.entries()].map(([path, rec]) => ({
          path,
          batches: rec.batches,
        })),
      })),
    }
  }

  protected _deserialize(raw: unknown): TrackerState | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const shape = raw as Partial<PersistedShape>
    // v1 had no `deleted` flag; its file entries deserialize cleanly here.
    if (
      (shape.schemaVersion !== 1 && shape.schemaVersion !== SCHEMA_VERSION) ||
      !Array.isArray(shape.sessions)
    ) {
      return undefined
    }
    const state: TrackerState = new Map()
    for (const s of shape.sessions) {
      const files = new Map<string, FileRecord>()
      for (const f of s.files) {
        const batches = Array.isArray(f.batches) ? [...f.batches] : []
        files.set(f.path, { batches })
      }
      state.set(s.sessionId, files)
    }
    return state
  }

  protected _onStateReplaced(state: TrackerState): void {
    // Recompute every session that already has a live observable. Sessions
    // observed later recompute lazily on first `changesFor`.
    for (const sessionId of this._observables.keys()) {
      void this._recompute(sessionId, state.get(sessionId))
    }
  }

  // -- public API -----------------------------------------------------

  record(
    sessionId: string,
    path: string,
    toolCallId: string,
    hunks: readonly DiffHunk[],
    created = false,
  ): void {
    if (hunks.length === 0 && !created) return
    const p = normalizePath(path)
    let files = this._state.get(sessionId)
    if (!files) {
      files = new Map()
      this._state.set(sessionId, files)
    }
    let rec = files.get(p)
    if (!rec) {
      rec = { batches: [] }
      files.set(p, rec)
    }
    const batches = rec.batches
    const idx = batches.findIndex((b) => b.toolCallId === toolCallId)
    const batch: DiffBatch = created
      ? { toolCallId, hunks: [...hunks], created: true }
      : { toolCallId, hunks: [...hunks] }
    if (idx >= 0) batches[idx] = batch
    else batches.push(batch)
    this._scheduleWrite()
    this._scheduleRecompute(sessionId)
  }

  changesFor(sessionId: string): IObservable<readonly SessionFileChange[]> {
    let obs = this._observables.get(sessionId)
    if (!obs) {
      obs = observableValue<readonly SessionFileChange[]>(`acp.sessionChanges.${sessionId}`, [])
      this._observables.set(sessionId, obs)
      void this._recompute(sessionId, this._state.get(sessionId))
    }
    return obs
  }

  clear(sessionId: string): void {
    if (!this._state.delete(sessionId)) return
    this._scheduleWrite()
    this._observables.get(sessionId)?.set([], undefined)
  }

  async previewRestore(
    sessionId: string,
    toolCallIds: readonly string[],
  ): Promise<RewindFileImpact> {
    return this._restore(sessionId, toolCallIds, false)
  }

  async restore(sessionId: string, toolCallIds: readonly string[]): Promise<RewindFileImpact> {
    return this._restore(sessionId, toolCallIds, true)
  }

  // -- internals ------------------------------------------------------

  /**
   * Shared engine for {@link previewRestore} / {@link restore}. For each tracked
   * file, un-applies only the batches in `ids` (the rewind's post-anchor edits)
   * from the current on-disk content — yielding the file's state at the anchor.
   * When `write` is true the reverted content is written back and the un-applied
   * batches are dropped from tracking (so session diff stays accurate).
   */
  private async _restore(
    sessionId: string,
    toolCallIds: readonly string[],
    write: boolean,
  ): Promise<RewindFileImpact> {
    const files = this._state.get(sessionId)
    const ids = new Set(toolCallIds)
    if (!files || ids.size === 0) return { filesChanged: [], insertions: 0, deletions: 0 }

    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0
    let mutated = false

    for (const [path, rec] of files.entries()) {
      const removed = rec.batches.filter((b) => b.toolCallId !== undefined && ids.has(b.toolCallId))
      if (removed.length === 0) continue

      const uri = path.includes('://') ? URI.parse(path) : URI.file(path)
      let current = ''
      try {
        current = await this._files.readFileText(uri)
      } catch {
        // File no longer on disk — nothing to revert.
        continue
      }
      // Un-apply only the post-anchor batches to recover the anchor-state content.
      const { baseline: reverted } = reconstructBaseline(current, removed)
      if (reverted === current) continue

      for (const batch of removed) {
        for (const hunk of batch.hunks) {
          for (const line of hunk.lines) {
            if (line[0] === '+') insertions++
            else if (line[0] === '-') deletions++
          }
        }
      }
      filesChanged.push(path)

      if (write) {
        await this._files.writeFile(uri, reverted)
        rec.batches = rec.batches.filter(
          (b) => b.toolCallId === undefined || !ids.has(b.toolCallId),
        )
        mutated = true
      }
    }

    if (mutated) {
      // Drop files whose batches were fully removed, then persist + refresh.
      for (const [path, rec] of [...files.entries()]) {
        if (rec.batches.length === 0) files.delete(path)
      }
      this._scheduleWrite()
      void this._recompute(sessionId, files)
    }

    return { filesChanged, insertions, deletions }
  }

  /**
   * Coalesce `record`-driven recomputes: an agent edit storm delivers many
   * updates per second, but the whole-file diff only needs recomputing once the
   * dust settles. Collapses to at most one recompute per throttle window.
   */
  private _scheduleRecompute(sessionId: string): void {
    if (this._pendingRecompute.has(sessionId)) return
    const timer = setTimeout(() => {
      this._pendingRecompute.delete(sessionId)
      void this._recompute(sessionId, this._state.get(sessionId))
    }, this.recomputeThrottleMs)
    this._pendingRecompute.set(sessionId, timer)
  }

  private async _recompute(
    sessionId: string,
    files: Map<string, FileRecord> | undefined,
  ): Promise<void> {
    const obs = this._observables.get(sessionId)
    if (!obs) return
    if (!files || files.size === 0) {
      obs.set([], undefined)
      return
    }
    const changes = await mapWithConcurrency(
      [...files.entries()],
      RECOMPUTE_READ_CONCURRENCY,
      ([path, rec]) => this._buildChange(path, rec),
    )
    obs.set(
      changes.filter((c): c is SessionFileChange => c !== undefined),
      undefined,
    )
  }

  private async _buildChange(
    path: string,
    record: FileRecord,
  ): Promise<SessionFileChange | undefined> {
    const uri = path.includes('://') ? URI.parse(path) : URI.file(path)
    let current = ''
    let existed = true
    try {
      current = await this._files.readFileText(uri)
    } catch {
      existed = false
    }
    const batches = record.batches
    if (batches.length === 0) return undefined
    const created = batches.some((b) => b.created)
    const { baseline, degraded } = reconstructBaseline(current, batches)
    if (baseline === current && existed && !created) return undefined
    const status: SessionFileChangeStatus = !existed
      ? 'deleted'
      : created
        ? 'added'
        : degraded
          ? 'degraded'
          : baseline === ''
            ? 'added'
            : 'modified'
    const effectiveBaseline = created && existed ? '' : baseline
    return { uri, path, baseline: effectiveBaseline, current, status, batchCount: batches.length }
  }
}

registerSingleton(
  ISessionChangeTrackerService,
  SessionChangeTrackerService,
  InstantiationType.Delayed,
)
