/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangeTrackerService — per-session, whole-file change tracking.
 *
 *  Baseline model: the first time an agent tool call touches a file, the agent
 *  reports the file's full pre-edit content (claude `originalFile`, codex diff
 *  `oldText`). We pin that snapshot as the session baseline for the file —
 *  first-touch-wins — and render the session diff as pinned-baseline vs the
 *  file's current on-disk content. Any later change to the file (further agent
 *  edits, shell writes, user tweaks) is reflected by re-reading disk; nothing
 *  is ever reconstructed by replaying hunks, so a hand-edited file can no
 *  longer corrupt the baseline. Hunk batches are still accumulated per tool
 *  call, but only to power rewind's file rollback ({@link restore}).
 *
 *  A second ingress ({@link recordWatched}) lets the fs-watch fallback surface
 *  files the agent changed without reporting (terminal commands); their
 *  baseline comes from the owning SCM provider (git HEAD) when available.
 *
 *  Only baselines + hunk batches are persisted (workspace-first via
 *  PersistedStateBase); current content is always re-read from disk so the
 *  store stays small and survives editor restarts / session resume.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  observableValue,
  registerSingleton,
  InstantiationType,
  URI,
  IFileService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
  ITelemetryService,
  ILoggerService,
  absolutePathToWorkspaceUri,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import { reconstructBaseline, type DiffBatch, type DiffHunk } from './sessionDiffReconstruct.js'

export type SessionFileChangeStatus = 'added' | 'modified' | 'deleted' | 'degraded'

/** How a change entered tracking: reported by an agent tool call, or inferred
 *  by the fs-watch fallback during a running turn. */
export type SessionChangeOrigin = 'agent' | 'watched'

/** Where the pinned baseline came from. 'none' = no pre-change content could be
 *  obtained — the file is known changed but the diff is not comparable. */
export type SessionBaselineSource = 'reported' | 'git' | 'reconstructed' | 'none'

export interface SessionFileChange {
  readonly uri: URI
  readonly path: string
  readonly baseline: string
  readonly current: string
  readonly status: SessionFileChangeStatus
  readonly origin: SessionChangeOrigin
  readonly baselineSource: SessionBaselineSource
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
   * hunks, e.g. an empty-content Write). `baseline` is the agent-reported full
   * pre-edit content (null = the call created the file); the first reported
   * value is pinned as the session baseline for the file.
   */
  record(
    sessionId: string,
    path: string,
    toolCallId: string,
    hunks: readonly DiffHunk[],
    opts?: { readonly created?: boolean; readonly baseline?: string | null },
  ): void
  /**
   * Surface a file change detected by the fs-watch fallback (agent shell
   * writes). No-op when the path is already tracked (the recompute still runs,
   * so an external change to a tracked file refreshes the view) or was
   * dismissed. `baseline` is the SCM-provided pre-change content (null = the
   * file did not exist before, i.e. it was created during the turn).
   */
  recordWatched(sessionId: string, path: string, opts?: { readonly baseline?: string | null }): void
  /**
   * Dismiss a watched entry (user judged it their own change). The entry stays
   * ignored for the session until an agent tool call touches the path.
   */
  dismissWatched(sessionId: string, path: string): void
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
const SCHEMA_VERSION = 3

/**
 * Hard caps on persisted data. A real workspace once accumulated ~150MB of
 * hunks in a single storage bucket (large generated/minified files diff as
 * megabyte-scale lines); loading it then shuttled 100MB+ payloads across the
 * IPC and log channels and rewrote the whole bucket on every edit, exhausting
 * the main-process heap and aborting it (exit 134). Budgets keep the tracker
 * bounded. Baselines are O(files touched) so they rarely hit the budget; hunk
 * batches are O(edits) and are the first to go — dropping them only degrades
 * rewind's file rollback, never the session diff itself.
 */
const MAX_TRACKED_SESSIONS = 20
const MAX_SESSION_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
/** Per-file cap on a pinned baseline; larger files fall back to hunk
 *  reconstruction (or 'none') rather than bloating the store. */
const MAX_BASELINE_BYTES = 4 * 1024 * 1024
/** Per-file cap on the current on-disk content we will read to compute a diff.
 *  A tracked file whose disk size exceeds this (e.g. a multi-GB `.vsidx` full
 *  text index swept in by the fs-watch fallback) is surfaced as degraded rather
 *  than read whole — a single oversized `readFileText` allocation OOMs the
 *  main process serving the read. */
const MAX_CURRENT_BYTES = 16 * 1024 * 1024

/** Serialized size of a value in bytes (safe on undefined). */
function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

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

/** Per-file tracking record. */
interface FileRecord {
  /** Display path in its first-seen casing (separator-normalized). The state
   *  map is keyed by the platform-aware comparison key instead, so an agent
   *  report (`d:/...`) and an fs-watch hit (`D:/...`) share one record. */
  path: string
  /** Per-tool-call hunk batches — rewind rollback data only, never used for display. */
  batches: DiffBatch[]
  /** Total distinct tool-call batches ever recorded (survives batch pruning). */
  batchCount: number
  origin: SessionChangeOrigin
  /** Pinned first-touch pre-change content; null = created during the session;
   *  absent = unknown (display falls back to hunk reconstruction / 'none'). */
  baseline?: string | null
  baselineSource?: 'reported' | 'git'
  /** Sticky create marker from the agent (survives batch pruning). */
  created?: boolean
  /** Watched entry dismissed by the user; cleared when an agent call touches the path. */
  ignored?: boolean
}

/** Tracker state keyed by sessionId → path comparison key → record. */
type TrackerState = Map<string, Map<string, FileRecord>>

interface PersistedFile {
  readonly path: string
  readonly batches: readonly DiffBatch[]
  readonly batchCount?: number
  readonly origin?: SessionChangeOrigin
  readonly baseline?: string | null
  readonly baselineSource?: 'reported' | 'git'
  readonly created?: boolean
  readonly ignored?: boolean
}

interface PersistedShape {
  readonly schemaVersion: number
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string
    readonly files: readonly PersistedFile[]
  }>
}

/** Canonicalize a file path for display (separators only — casing is preserved;
 *  identity is the comparison key's job). Non-file URIs pass through; POSIX
 *  absolute paths pass through unchanged (they are remote host paths — folding
 *  them through URI.file().fsPath would flip the separators on Windows). */
function normalizePath(path: string): string {
  return path.includes('://') || path.startsWith('/') ? path : URI.file(path).fsPath
}

function recordBytes(rec: FileRecord): number {
  let bytes = rec.baseline != null ? jsonSize(rec.baseline) : 0
  for (const b of rec.batches) bytes += jsonSize(b)
  return bytes
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

  /** Approximate serialized size per session, kept in sync on record/load. */
  private readonly _sessionBytes = new Map<string, number>()

  /** Set by _deserialize when it pruned over-budget entries → persist the slimmed state. */
  private _prunedOnLoad = false

  /** Sessions with a recompute pending inside the current throttle window. */
  private readonly _pendingRecompute = new Map<string, ReturnType<typeof setTimeout>>()

  /** Throttle window between a `record` and its recompute. Overridable in tests
   *  (set to 0 for a synchronous flush). */
  recomputeThrottleMs = RECOMPUTE_THROTTLE_MS

  /** Size budgets — overridable in tests. */
  maxTrackedSessions = MAX_TRACKED_SESSIONS
  maxSessionBytes = MAX_SESSION_BYTES
  maxTotalBytes = MAX_TOTAL_BYTES
  maxBaselineBytes = MAX_BASELINE_BYTES
  maxCurrentBytes = MAX_CURRENT_BYTES

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _files: IFileService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
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
        files: [...files.values()].map((rec) => ({
          path: rec.path,
          batches: rec.batches,
          batchCount: rec.batchCount,
          origin: rec.origin,
          ...(rec.baseline !== undefined ? { baseline: rec.baseline } : {}),
          ...(rec.baselineSource !== undefined ? { baselineSource: rec.baselineSource } : {}),
          ...(rec.created ? { created: true } : {}),
          ...(rec.ignored ? { ignored: true } : {}),
        })),
      })),
    }
  }

  protected _deserialize(raw: unknown): TrackerState | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const shape = raw as Partial<PersistedShape>
    // v1/v2 stored hunk batches only (baselines were reconstructed) — the
    // project is pre-release, so old data is dropped rather than migrated.
    if (shape.schemaVersion !== SCHEMA_VERSION || !Array.isArray(shape.sessions)) {
      return undefined
    }
    this._sessionBytes.clear()
    const state: TrackerState = new Map()
    let total = 0
    let pruned = false
    for (const s of shape.sessions) {
      // Per-entry isolation: one malformed session must not nuke the rest.
      if (!s || typeof s.sessionId !== 'string' || !Array.isArray(s.files)) {
        pruned = true
        continue
      }
      const files = new Map<string, FileRecord>()
      let bytes = 0
      for (const f of s.files) {
        const batches = Array.isArray(f.batches) ? [...f.batches] : []
        const rec: FileRecord = {
          path: f.path,
          batches,
          batchCount: typeof f.batchCount === 'number' ? f.batchCount : batches.length,
          origin: f.origin === 'watched' ? 'watched' : 'agent',
          ...(f.baseline !== undefined ? { baseline: f.baseline } : {}),
          ...(f.baselineSource === 'reported' || f.baselineSource === 'git'
            ? { baselineSource: f.baselineSource }
            : {}),
          ...(f.created ? { created: true } : {}),
          ...(f.ignored ? { ignored: true } : {}),
        }
        const key = this._pathKey(f.path)
        const existing = files.get(key)
        if (existing) {
          // Stores written before comparison-key tracking may list the same
          // file twice under different casings — fold them into one record.
          existing.batches.push(...rec.batches)
          existing.batchCount += rec.batchCount
          if (rec.origin === 'agent') {
            existing.origin = 'agent'
            delete existing.ignored
          }
          if (existing.baseline === undefined && rec.baseline !== undefined) {
            existing.baseline = rec.baseline
            if (rec.baselineSource !== undefined) existing.baselineSource = rec.baselineSource
          }
          if (rec.created) existing.created = true
        } else {
          files.set(key, rec)
        }
        bytes += recordBytes(rec)
      }
      if (bytes > this.maxSessionBytes) {
        // Try the graceful degradation first: batches are rollback data only.
        for (const rec of files.values()) rec.batches = []
        bytes = 0
        for (const rec of files.values()) bytes += recordBytes(rec)
        pruned = true
      }
      if (bytes > this.maxSessionBytes) {
        this._logger.warn(
          `pruning session ${s.sessionId} on load — ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds the per-session budget`,
        )
        pruned = true
        continue
      }
      state.set(s.sessionId, files)
      this._sessionBytes.set(s.sessionId, bytes)
      total += bytes
    }
    // Serialized order is append order (oldest first) — evict from the front.
    while (state.size > this.maxTrackedSessions || total > this.maxTotalBytes) {
      const oldest = state.keys().next().value
      if (oldest === undefined) break
      total -= this._sessionBytes.get(oldest) ?? 0
      state.delete(oldest)
      this._sessionBytes.delete(oldest)
      pruned = true
    }
    if (pruned) {
      this._prunedOnLoad = true
      this._logger.warn(
        `pruned ${STORAGE_KEY} to fit the size budgets; slimmed state will be persisted`,
      )
    }
    return state
  }

  protected _onStateReplaced(state: TrackerState): void {
    if (state.size === 0) this._sessionBytes.clear()
    // Recompute every session that already has a live observable. Sessions
    // observed later recompute lazily on first `changesFor`.
    for (const sessionId of this._observables.keys()) {
      void this._recompute(sessionId, state.get(sessionId))
    }
    if (this._prunedOnLoad) {
      this._prunedOnLoad = false
      this._scheduleWrite()
    }
  }

  // -- public API -----------------------------------------------------

  record(
    sessionId: string,
    path: string,
    toolCallId: string,
    hunks: readonly DiffHunk[],
    opts?: { readonly created?: boolean; readonly baseline?: string | null },
  ): void {
    const created = opts?.created === true
    if (hunks.length === 0 && !created) return
    const batch: DiffBatch = created
      ? { toolCallId, hunks: [...hunks], created: true }
      : { toolCallId, hunks: [...hunks] }
    const batchBytes = jsonSize(batch)
    if (batchBytes > this.maxSessionBytes) {
      this._logger.warn(
        `dropping ${(batchBytes / 1024 / 1024).toFixed(1)}MB edit batch for session ${sessionId} — exceeds the per-session budget`,
      )
      return
    }
    const key = this._pathKey(path)
    const files = this._filesFor(sessionId)
    let rec = files.get(key)
    if (!rec) {
      rec = { path: normalizePath(path), batches: [], batchCount: 0, origin: 'agent' }
      files.set(key, rec)
    }
    let bytes = this._sessionBytes.get(sessionId) ?? 0
    // An agent report is authoritative: it upgrades a watched entry and
    // un-dismisses an ignored one.
    rec.origin = 'agent'
    delete rec.ignored
    if (created) rec.created = true
    // First-touch-wins: pin the earliest reported pre-edit content as the
    // session baseline. A watched entry's git baseline (recorded even earlier)
    // also wins over a later agent report for the same reason.
    if (rec.baseline === undefined && opts?.baseline !== undefined) {
      const baselineBytes = opts.baseline === null ? 0 : jsonSize(opts.baseline)
      if (baselineBytes > this.maxBaselineBytes) {
        this._logger.warn(
          `not pinning a ${(baselineBytes / 1024 / 1024).toFixed(1)}MB baseline for ${key} — exceeds the per-file cap`,
        )
      } else {
        rec.baseline = opts.baseline
        rec.baselineSource = 'reported'
        bytes += baselineBytes
      }
    } else if (
      rec.baseline === null &&
      rec.baselineSource !== 'reported' &&
      typeof opts?.baseline === 'string'
    ) {
      // A watched entry pins null when no HEAD was available; the agent's later
      // real baseline must win. The agent's own Write-create null (source
      // 'reported') is never upgraded. The old null baseline accounts 0 bytes.
      const baselineBytes = jsonSize(opts.baseline)
      if (baselineBytes > this.maxBaselineBytes) {
        this._logger.warn(
          `not upgrading to a ${(baselineBytes / 1024 / 1024).toFixed(1)}MB baseline for ${key} — exceeds the per-file cap`,
        )
      } else {
        rec.baseline = opts.baseline
        rec.baselineSource = 'reported'
        bytes += baselineBytes
      }
    }
    const batches = rec.batches
    const idx = batches.findIndex((b) => b.toolCallId === toolCallId)
    if (idx >= 0) {
      bytes -= jsonSize(batches[idx])
      batches[idx] = batch
    } else {
      batches.push(batch)
      rec.batchCount++
    }
    bytes += batchBytes

    if (bytes > this.maxSessionBytes) {
      // Batches are rewind rollback data only — drop them all and keep the
      // pinned baselines, so the session diff survives at the cost of rewind's
      // file rollback for this session.
      this._logger.warn(
        `dropping hunk batches for session ${sessionId} — accumulated data exceeds the ${(this.maxSessionBytes / 1024 / 1024).toFixed(0)}MB per-session budget; session diff is kept, rewind file rollback is degraded`,
      )
      for (const r of files.values()) r.batches = []
      bytes = 0
      for (const r of files.values()) bytes += recordBytes(r)
      if (bytes > this.maxSessionBytes) {
        this._logger.warn(`baselines alone exceed the budget — dropping session ${sessionId}`)
        this.clear(sessionId)
        return
      }
    }
    this._sessionBytes.set(sessionId, bytes)
    this._touchLru(sessionId, files)
    this._scheduleWrite()
    this._scheduleRecompute(sessionId)
  }

  recordWatched(
    sessionId: string,
    path: string,
    opts?: { readonly baseline?: string | null },
  ): void {
    const key = this._pathKey(path)
    const files = this._filesFor(sessionId)
    const existing = files.get(key)
    if (existing) {
      // Already tracked (or dismissed) — just refresh: the disk changed under
      // a tracked file, so the diff against its pinned baseline moved too.
      if (!existing.ignored) this._scheduleRecompute(sessionId)
      return
    }
    const rec: FileRecord = {
      path: normalizePath(path),
      batches: [],
      batchCount: 0,
      origin: 'watched',
    }
    if (opts?.baseline !== undefined) {
      const baselineBytes = opts.baseline === null ? 0 : jsonSize(opts.baseline)
      if (baselineBytes <= this.maxBaselineBytes) {
        rec.baseline = opts.baseline
        if (opts.baseline !== null) rec.baselineSource = 'git'
      }
    }
    files.set(key, rec)
    this._sessionBytes.set(sessionId, (this._sessionBytes.get(sessionId) ?? 0) + recordBytes(rec))
    this._touchLru(sessionId, files)
    this._scheduleWrite()
    this._scheduleRecompute(sessionId)
  }

  dismissWatched(sessionId: string, path: string): void {
    const files = this._state.get(sessionId)
    const rec = files?.get(this._pathKey(path))
    if (!rec || rec.origin !== 'watched' || rec.ignored) return
    rec.ignored = true
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
    this._sessionBytes.delete(sessionId)
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

  /** Platform-aware identity key for a tracked path: folds Windows drive-letter
   *  and (on win32/darwin) path casing, so agent-reported and fs-watch paths
   *  address the same record. URI strings go through URI comparison. */
  private _pathKey(path: string): string {
    return path.includes('://')
      ? this._uriIdentity.getComparisonKey(URI.parse(path))
      : this._uriIdentity.getPathComparisonKey(path)
  }

  /** Agent-reported path string → resource URI. URI strings pass through; bare
   *  absolute paths inherit the workspace folder's scheme/authority so a remote
   *  workspace resolves them to remote-ssh instead of the local file scheme. */
  private _pathToUri(path: string): URI {
    return path.includes('://')
      ? URI.parse(path)
      : absolutePathToWorkspaceUri(path, this._workspace.current?.folder)
  }

  private _filesFor(sessionId: string): Map<string, FileRecord> {
    let files = this._state.get(sessionId)
    if (!files) {
      files = new Map()
      this._state.set(sessionId, files)
    }
    return files
  }

  /** Refresh LRU recency (most-recently-recorded session sits at the end) and
   *  evict least-recently-used sessions until the global budgets hold. */
  private _touchLru(sessionId: string, files: Map<string, FileRecord>): void {
    this._state.delete(sessionId)
    this._state.set(sessionId, files)
    let total = 0
    for (const b of this._sessionBytes.values()) total += b
    while (this._state.size > this.maxTrackedSessions || total > this.maxTotalBytes) {
      let oldest: string | undefined
      for (const id of this._state.keys()) {
        if (id === sessionId && this._state.size > 1) continue
        oldest = id
        break
      }
      if (oldest === undefined) break
      this._logger.warn(`evicting change tracking for session ${oldest} — global budget exceeded`)
      total -= this._sessionBytes.get(oldest) ?? 0
      this._state.delete(oldest)
      this._sessionBytes.delete(oldest)
      this._observables.get(oldest)?.set([], undefined)
    }
  }

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

    for (const rec of files.values()) {
      const removed = rec.batches.filter((b) => b.toolCallId !== undefined && ids.has(b.toolCallId))
      if (removed.length === 0) continue

      const uri = this._pathToUri(rec.path)
      let current = ''
      try {
        const stat = await this._files.stat(uri)
        if (stat.size > this.maxCurrentBytes) {
          this._logger.warn(
            `skipping restore of ${rec.path} — ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds the ${(this.maxCurrentBytes / 1024 / 1024).toFixed(0)}MB read cap`,
          )
          continue
        }
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
      filesChanged.push(rec.path)

      if (write) {
        await this._files.writeFile(uri, reverted)
        rec.batches = rec.batches.filter(
          (b) => b.toolCallId === undefined || !ids.has(b.toolCallId),
        )
        rec.batchCount = Math.max(0, rec.batchCount - removed.length)
        mutated = true
      }
    }

    if (mutated) {
      // Drop files whose batches were fully removed (their content is back at
      // the pre-edit state, and a later re-edit should pin a fresh baseline),
      // then persist + refresh.
      let bytes = 0
      for (const [key, rec] of [...files.entries()]) {
        if (rec.batches.length === 0 && rec.origin === 'agent') files.delete(key)
        else bytes += recordBytes(rec)
      }
      this._sessionBytes.set(sessionId, bytes)
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
      [...files.values()],
      RECOMPUTE_READ_CONCURRENCY,
      (rec) => this._buildChange(rec),
    )
    obs.set(
      changes.filter((c): c is SessionFileChange => c !== undefined),
      undefined,
    )
  }

  private async _buildChange(record: FileRecord): Promise<SessionFileChange | undefined> {
    if (record.ignored) return undefined
    if (record.batchCount === 0 && record.origin === 'agent') return undefined
    const uri = this._pathToUri(record.path)
    let current = ''
    let existed = true
    let tooLarge = false
    try {
      const stat = await this._files.stat(uri)
      if (stat.size > this.maxCurrentBytes) {
        tooLarge = true
        this._logger.debug(
          `skipping diff of ${record.path} — ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds the ${(this.maxCurrentBytes / 1024 / 1024).toFixed(0)}MB read cap`,
        )
      } else {
        current = await this._files.readFileText(uri)
      }
    } catch {
      existed = false
    }

    if (tooLarge) {
      // Known-changed but too large to diff: surface a safe degraded row without
      // ever reading the full content into memory.
      return {
        uri,
        path: record.path,
        baseline: '',
        current: '',
        status: 'degraded',
        origin: record.origin,
        baselineSource: 'none',
        batchCount: record.batchCount,
      }
    }

    // A pinned baseline of null means the file was created during the session;
    // the sticky created flag covers legacy agents that report no baseline.
    const created =
      record.baseline === null ||
      (record.baseline === undefined &&
        (record.created === true || record.batches.some((b) => b.created)))

    let baseline: string
    let source: SessionBaselineSource
    let degraded = false
    if (record.baseline !== undefined) {
      baseline = record.baseline ?? ''
      source = record.baselineSource ?? 'reported'
    } else if (record.batches.length > 0) {
      const r = reconstructBaseline(current, record.batches)
      baseline = r.baseline
      degraded = r.degraded
      source = 'reconstructed'
    } else if (record.origin === 'watched') {
      // Watched change with no obtainable pre-change content: known changed,
      // not comparable. Baseline mirrors current so no false diff is claimed.
      baseline = current
      source = 'none'
    } else {
      return undefined
    }

    // Created then deleted → net-zero for the session; drop the row.
    if (!existed && created) return undefined
    // Watched entry with no obtainable baseline and the file already gone —
    // an atomic-write tmp or create-then-delete; net-zero, drop the row.
    if (!existed && source === 'none') return undefined
    // Changed back to the baseline (or rewound) → self-heals out of the list.
    if (source !== 'none' && baseline === current && existed && !created) return undefined

    const status: SessionFileChangeStatus = !existed
      ? 'deleted'
      : created
        ? 'added'
        : degraded || source === 'none'
          ? 'degraded'
          : baseline === ''
            ? 'added'
            : 'modified'
    const effectiveBaseline = created && existed ? '' : baseline
    return {
      uri,
      path: record.path,
      baseline: effectiveBaseline,
      current,
      status,
      origin: record.origin,
      baselineSource: source,
      batchCount: record.batchCount,
    }
  }
}

registerSingleton(
  ISessionChangeTrackerService,
  SessionChangeTrackerService,
  InstantiationType.Delayed,
)
