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
import { probeIsBinary } from '../../files/binaryDetection.js'
import { IMemoryPressureService } from '../../memory/memoryPressureService.js'
import { MemoryPressureLevel } from '../../memory/memoryPressureLevels.js'
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
  /**
   * False when the two texts above are absent by design — the file was never
   * read (too large, not a regular file) or its content was released under
   * memory pressure. `status` alone does not answer this: a `degraded` row may
   * still carry both texts in full and only mean "the baseline is imprecise"
   * (a hunk could not be located, or there is no comparable pre-change
   * content). Consumers that write these texts somewhere must check this flag,
   * not the status.
   */
  readonly hasTexts: boolean
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
  /**
   * Whether the path is already tracked for the session.
   *
   * Distinct from looking for a row in {@link changesFor}: a record can exist
   * without producing one (dismissed, binary, self-healed, or a failed stat).
   * Callers that use "is it tracked?" to decide whether to pay for a pre-change
   * baseline lookup need this answer, not the rendered one — otherwise those
   * states send them back for a fresh baseline on every single pass.
   */
  hasEntry(sessionId: string, path: string): boolean
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

/** Cap on the live in-memory diff results held per session, and across all
 *  sessions, in `_observables`. Distinct from the budgets above: those bound
 *  what is *persisted* (pinned baselines + hunk batches), while every recompute
 *  additionally materializes `baseline` AND `current` in full for each tracked
 *  file and parks the result in an observable. A long agent session accumulates
 *  tracked files, and nothing measured or released that array — it is how a
 *  renderer once climbed from 0.7GB to 5.4GB over two hours and was OOM-killed.
 *  Sizes are UTF-16 string lengths doubled, matching what the JS heap holds.
 *  Keep the per-session cap at or below the total: the session being recomputed
 *  is never a candidate for the global sweep, so a per-session cap above the
 *  total would leave the sweep with nothing it is allowed to release. */
const MAX_LIVE_CHANGE_BYTES = 32 * 1024 * 1024
const MAX_LIVE_CHANGE_TOTAL_BYTES = 64 * 1024 * 1024

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
  /** Bumped by every mutation that changes what a rebuild would produce — see
   *  {@link SessionChangeTrackerService._invalidateBuilt}. A pass captures it
   *  before reading the record and only installs its result when the revision
   *  still matches. */
  rev: number
  /** The row the last completed build produced, reusable while the file's size
   *  and mtime are unchanged. Memory-only; never serialized.
   *
   *  `row: null` is a real cached answer (this file currently produces no row),
   *  which is why it is `| null` rather than an optional property. */
  lastBuilt?: {
    readonly size: number
    readonly mtime: number
    readonly row: SessionFileChange | null
  }
}

/** One file's rebuilt row plus the on-disk state it was built from. */
interface BuiltRow {
  readonly record: FileRecord
  /** Identity of the content this row reflects; null when the file could not be
   *  stat'ed at all, so there is nothing to key a cache on. */
  readonly stamp: { readonly size: number; readonly mtime: number; readonly rev: number } | null
  /** null = this file currently produces no row. Mutable: `_capLiveChanges`
   *  degrades it in place so the cache is updated with what was published. */
  change: SessionFileChange | null
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

/** Heap cost of one live diff row: both full texts, as UTF-16. */
function changeBytes(change: SessionFileChange): number {
  // Equal texts mean one string, not two: `_buildChange` gives a `baselineSource: 'none'`
  // row `baseline = current` — the same string — and every other row whose two texts
  // compare equal was dropped by the self-heal check or normalized to an empty baseline
  // before it could be published. (An upcoming row shape carrying two distinct but
  // identical texts would be under-counted here.) Counting the mirror twice would
  // inflate both the budget that row competes for and the bytes a release claims.
  const texts =
    change.baseline === change.current
      ? change.current.length
      : change.baseline.length + change.current.length
  return texts * 2
}

/** Strip the two full texts from a row, keeping it visible as a known-changed
 *  but non-comparable entry. Same shape `_buildChange` produces for a file too
 *  large to read, so the UI already renders it correctly. */
function degradeChange(change: SessionFileChange): SessionFileChange {
  return { ...change, baseline: '', current: '', status: 'degraded', hasTexts: false }
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

  /** Heap cost of the live diff rows currently parked in {@link _observables},
   *  per session. Kept in lockstep with what `_recompute` writes: the same pass
   *  that degrades over-budget rows is the one that records their size, so a
   *  byte counted here is always a byte some row still holds. */
  private readonly _liveChangeBytes = new Map<string, number>()

  /** Set by _deserialize when it pruned over-budget entries → persist the slimmed state. */
  private _prunedOnLoad = false

  /** Sessions with a recompute pending inside the current throttle window. */
  private readonly _pendingRecompute = new Map<string, ReturnType<typeof setTimeout>>()

  /** Sessions with a recompute pass in flight. A pass stats and reads every
   *  tracked file, so it routinely outlives the throttle window that scheduled
   *  it — without this guard the four call sites below would each start their
   *  own overlapping pass over the same records. */
  private readonly _recomputeRunning = new Set<string>()

  /** Sessions asked to recompute while a pass was already in flight; each is
   *  re-run exactly once after that pass settles. */
  private readonly _recomputeAgain = new Set<string>()

  /** Throttle window between a `record` and its recompute. Overridable in tests
   *  (set to 0 for a synchronous flush). */
  recomputeThrottleMs = RECOMPUTE_THROTTLE_MS

  /** Size budgets — overridable in tests. */
  maxTrackedSessions = MAX_TRACKED_SESSIONS
  maxSessionBytes = MAX_SESSION_BYTES
  maxTotalBytes = MAX_TOTAL_BYTES
  maxBaselineBytes = MAX_BASELINE_BYTES
  maxCurrentBytes = MAX_CURRENT_BYTES
  maxLiveChangeBytes = MAX_LIVE_CHANGE_BYTES
  maxLiveChangeTotalBytes = MAX_LIVE_CHANGE_TOTAL_BYTES

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _files: IFileService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IMemoryPressureService memoryPressure: IMemoryPressureService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpSessionChanges',
      loggerName: 'ACP Session Changes',
      persistFailureEvent: 'acp.session_changes_persist_failed',
    })
    // Registered here rather than by MemoryPressureContribution: the rows are private
    // to this class and nothing else can reach them. They are also the biggest thing
    // this service holds — two full copies of every changed file, per session — and
    // they were the memory the renderer died with, while being invisible to the
    // holdership report that is supposed to account for exactly that.
    this._register(
      memoryPressure.registerReleaser({
        id: 'sessionChanges.liveTexts',
        release: (level) =>
          // Only at the last stop. One session's live-text budget is 32MiB (64MiB across
          // sessions), small next to the elevated line (1.5GiB), so dropping every inline
          // diff on a warning shot would cost the user something visible and free nothing
          // that matters. At critical, losing the inline comparison beats losing the window.
          level === MemoryPressureLevel.Critical ? this._releaseLiveTexts() : 0,
      }),
    )
  }

  /**
   * Hand back every live diff text, across all sessions. The rows themselves stay —
   * path, status, counts — so the panel keeps listing what changed; only the inline
   * comparison goes. The build cache is degraded in the same pass for the same reason
   * `_capLiveChanges` does it: a full-text row left in the cache would be published
   * straight back by the next recompute (any neighbour file changing is enough),
   * while `_liveChangeBytes` already reads zero.
   */
  private _releaseLiveTexts(): number {
    // Copied before iterating: `obs.set` notifies subscribers synchronously, and a
    // listener is free to open or close another session's panel from there.
    let freed = 0
    for (const sessionId of [...this._observables.keys()]) {
      freed += this._degradeSessionRows(sessionId)
    }
    return freed
  }

  override dispose(): void {
    for (const timer of this._pendingRecompute.values()) clearTimeout(timer)
    this._pendingRecompute.clear()
    this._recomputeRunning.clear()
    this._recomputeAgain.clear()
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
          rev: 0,
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
      this._requestRecompute(sessionId)
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
      rec = { path: normalizePath(path), batches: [], batchCount: 0, origin: 'agent', rev: 0 }
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
      for (const r of files.values()) {
        r.batches = []
        // A record with no pinned baseline falls from 'reconstructed' to 'none'
        // here, which changes what its row says even though the file on disk did
        // not move.
        this._invalidateBuilt(r)
      }
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
    this._invalidateBuilt(rec)
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
      rev: 0,
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
    this._invalidateBuilt(rec)
    this._scheduleRecompute(sessionId)
  }

  changesFor(sessionId: string): IObservable<readonly SessionFileChange[]> {
    let obs = this._observables.get(sessionId)
    if (!obs) {
      obs = observableValue<readonly SessionFileChange[]>(`acp.sessionChanges.${sessionId}`, [])
      this._observables.set(sessionId, obs)
      this._requestRecompute(sessionId)
    }
    return obs
  }

  hasEntry(sessionId: string, path: string): boolean {
    return this._state.get(sessionId)?.has(this._pathKey(path)) === true
  }

  clear(sessionId: string): void {
    if (!this._state.delete(sessionId)) return
    this._sessionBytes.delete(sessionId)
    this._liveChangeBytes.delete(sessionId)
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
      this._liveChangeBytes.delete(oldest)
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
        if (!stat.isFile) {
          this._logger.warn(`skipping restore of ${rec.path} — not a regular file`)
          continue
        }
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
        // The write-back can land on the same mtime+size stamp as the content it
        // replaced, which would otherwise be served from the build cache.
        this._invalidateBuilt(rec)
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
      this._requestRecompute(sessionId)
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
      this._requestRecompute(sessionId)
    }, this.recomputeThrottleMs)
    this._pendingRecompute.set(sessionId, timer)
  }

  /**
   * Ask for a recompute of one session, running at most one pass at a time.
   *
   * The throttle above only coalesces *requests*; a pass can still outlive its
   * window (it stats and reads every tracked file), and the four callers — the
   * throttle timer, `changesFor`, `_onStateReplaced` and `_restore` — can ask
   * concurrently. Overlapping passes would multiply the reads of every tracked
   * file instead of collapsing them, which is exactly the shape that made a
   * renderer re-read one 16MB binary 113 times over seven minutes.
   *
   * A request arriving mid-pass is remembered and re-run once, so the
   * observable never settles on a state that predates the caller's write.
   *
   * One pass means one file read that never settles holds the whole list — there is
   * no watchdog, because `IFileService` has none to inherit and a pass awaits *all*
   * its reads before publishing, so a single hung read froze the list before this
   * guard existed too (with one hung pass per request instead of one in total).
   */
  private _requestRecompute(sessionId: string): void {
    if (this._recomputeRunning.has(sessionId)) {
      this._recomputeAgain.add(sessionId)
      return
    }
    void this._runRecomputeLoop(sessionId)
  }

  private async _runRecomputeLoop(sessionId: string): Promise<void> {
    // Synchronous up to the first await, so `_recomputeRunning` is claimed
    // before any other caller can observe the gap.
    this._recomputeRunning.add(sessionId)
    try {
      do {
        this._recomputeAgain.delete(sessionId)
        await this._recompute(sessionId)
      } while (this._recomputeAgain.has(sessionId))
    } catch (err) {
      // `mapWithConcurrency` propagates a read failure and every caller here is
      // fire-and-forget, so without this the rejection escapes as an unhandled
      // one. One file failing to read is not a reason to lose the whole panel.
      this._logger.warn(`recompute failed for session ${sessionId}`, err)
    } finally {
      this._recomputeRunning.delete(sessionId)
      // A request that landed between the loop's last check and the release
      // would otherwise be dropped on the floor.
      if (this._recomputeAgain.delete(sessionId)) this._requestRecompute(sessionId)
    }
  }

  /**
   * Rebuild one session's rows from its current records.
   *
   * Reads `_state` at call time rather than taking the caller's map: the pass
   * awaits between files, and `_touchLru` can evict this session during those
   * awaits. Holding the stale map would then write rows back into an observable
   * for a session that no longer exists in `_state`, and nothing would ever
   * release them.
   */
  private async _recompute(sessionId: string): Promise<void> {
    const obs = this._observables.get(sessionId)
    if (!obs) return
    const files = this._state.get(sessionId)
    if (!files || files.size === 0) {
      this._liveChangeBytes.delete(sessionId)
      obs.set([], undefined)
      return
    }
    const built = await mapWithConcurrency([...files.values()], RECOMPUTE_READ_CONCURRENCY, (rec) =>
      this._buildChange(rec),
    )
    // `clear()`, an LRU eviction or a workspace swap can land while the reads are in
    // flight. The rows this pass built describe a state that no longer exists; they
    // must not be published — a cleared list would come back to life, and `changesFor`
    // never recomputes an observable that already exists, so nothing would clear it
    // again and its texts would sit there with no account of them.
    if (this._state.get(sessionId) !== files) {
      this._liveChangeBytes.delete(sessionId)
      obs.set([], undefined)
      return
    }
    this._capLiveChanges(sessionId, built)
    this._rememberBuilt(built)
    const rows: SessionFileChange[] = []
    for (const b of built) {
      if (b.change !== null) rows.push(b.change)
    }
    obs.set(rows, undefined)
  }

  /** Force the next build of this record's row from scratch. */
  private _invalidateBuilt(rec: FileRecord): void {
    rec.rev++
    delete rec.lastBuilt
  }

  /**
   * Park the rows just published as the next pass's cache, so a file whose size
   * and mtime have not moved is never read again.
   *
   * Runs *after* `_capLiveChanges` deliberately: caching rows as they stood
   * before the cap would hold on to the very full texts the cap just released,
   * for as long as the file stays unchanged — the retention shape this budget
   * exists to prevent, and one no assertion would notice.
   *
   * A row whose revision no longer matches was built before a `record()` landed
   * mid-pass and used the pre-edit baseline; it is dropped rather than installed
   * so the next pass rebuilds it.
   */
  private _rememberBuilt(built: readonly BuiltRow[]): void {
    for (const b of built) {
      const stamp = b.stamp
      if (stamp === null || stamp.rev !== b.record.rev) continue
      b.record.lastBuilt = { size: stamp.size, mtime: stamp.mtime, row: b.change }
    }
  }

  /**
   * Release one session's live rows — in both places they are held — and zero its
   * live-byte account, which is the same act: the rows that were counted are exactly
   * the rows being emptied.
   *
   * Degrading the observable alone would leave each row's two full texts alive
   * in that session's build cache while `_liveChangeBytes` already reports it at
   * zero, i.e. unaccounted retention. Rows are matched by identity: the cached
   * row is the same object that was published.
   *
   * Returns the bytes actually freed, so callers subtract what was released instead
   * of a number read from a separate map that could have drifted from it.
   */
  private _degradeSessionRows(sessionId: string): number {
    const obs = this._observables.get(sessionId)
    if (!obs) return 0
    const previous = obs.get()
    const next = previous.map(degradeChange)
    obs.set(next, undefined)

    let freed = 0
    for (const row of previous) freed += changeBytes(row)
    this._liveChangeBytes.set(sessionId, 0)
    if (freed === 0) return 0

    const files = this._state.get(sessionId)
    if (!files) return freed
    const degradedByOld = new Map<SessionFileChange, SessionFileChange>()
    for (let i = 0; i < previous.length; i++) {
      const before = previous[i]
      const after = next[i]
      if (before !== undefined && after !== undefined) degradedByOld.set(before, after)
    }
    for (const rec of files.values()) {
      const cached = rec.lastBuilt
      if (cached === undefined || cached.row === null) continue
      const degraded = degradedByOld.get(cached.row)
      if (degraded !== undefined) {
        rec.lastBuilt = { size: cached.size, mtime: cached.mtime, row: degraded }
      }
    }
    return freed
  }

  /**
   * Bound the heap held by one session's live diff rows, and by all sessions
   * together, then record what survived. Measuring and releasing are the same
   * pass over the same array on purpose: a budget whose accounting can outrun
   * its release path either reports a permanent overage it can never act on, or
   * spins trying to free bytes nothing holds.
   *
   * Heaviest rows degrade first — dropping their two full texts costs only the
   * inline diff for the files least likely to be reviewed inline anyway.
   *
   * Degrades the `BuiltRow`s in place rather than returning a new array, so the
   * caller's `_rememberBuilt` caches the row that was actually published instead
   * of the pre-cap one.
   */
  private _capLiveChanges(sessionId: string, built: BuiltRow[]): void {
    let bytes = 0
    for (const b of built) {
      if (b.change !== null) bytes += changeBytes(b.change)
    }

    if (bytes > this.maxLiveChangeBytes) {
      const heaviestFirst = built
        .map((b, index) => ({ index, bytes: b.change === null ? 0 : changeBytes(b.change) }))
        .sort((a, b) => b.bytes - a.bytes)
      for (const { index, bytes: rowBytes } of heaviestFirst) {
        if (bytes <= this.maxLiveChangeBytes) break
        // Degrading frees exactly `rowBytes`, so a zero-byte row frees nothing:
        // stop rather than spin once the heaviest remaining row is already bare.
        if (rowBytes === 0) break
        const row = built[index]
        if (row === undefined || row.change === null) continue
        row.change = degradeChange(row.change)
        bytes -= rowBytes
      }
      this._logger.warn(
        `degraded oversized diff rows for session ${sessionId} — live change budget exceeded`,
      )
    }

    this._liveChangeBytes.set(sessionId, bytes)

    let total = 0
    for (const b of this._liveChangeBytes.values()) total += b
    if (total > this.maxLiveChangeTotalBytes) {
      // Over the global ceiling: release other sessions' rows wholesale, least
      // recently recorded first. `_state` is the LRU order `_touchLru` already
      // maintains (most-recently-recorded last); `_observables` insertion order
      // would instead be "whoever opened the panel first", which says nothing
      // about which session is cold. The session being recomputed is kept.
      for (const otherId of this._state.keys()) {
        if (total <= this.maxLiveChangeTotalBytes) break
        if (otherId === sessionId) continue
        const freed = this._degradeSessionRows(otherId)
        if (freed === 0) continue
        total -= freed
        this._logger.warn(
          `degraded live diff rows for session ${otherId} — global live change budget exceeded`,
        )
      }
    }
  }

  /**
   * Rebuild one file's row.
   *
   * Cheap-answer-first ordering, most of which exists to avoid a full read:
   *  - `ignored` / no batches: no row at all.
   *  - stat fails: the file is gone; nothing to stamp, so nothing to cache.
   *  - the cached `(size, mtime)` still matches: reuse the row outright.
   *  - binary: no row. Checked *before* the size gates so an oversized binary
   *    can't slip through as a degraded placeholder row — "binaries never enter
   *    tracking" has no size caveat.
   *  - not a regular file, over the read cap, or provably about to be degraded:
   *    a degraded row, no read.
   */
  private async _buildChange(record: FileRecord): Promise<BuiltRow> {
    // Read the cache and the revision it belongs to together, before the first
    // await: the pass suspends in `stat`, and a `record()` landing there would
    // otherwise leave `cached` describing a record that no longer exists while
    // the stamp below picks up the revision of the replacement.
    const cached = record.lastBuilt
    const rev = record.rev
    const miss = (change: SessionFileChange | null, stamp: BuiltRow['stamp']): BuiltRow => ({
      record,
      stamp,
      change,
    })
    if (record.ignored) return miss(null, null)
    if (record.batchCount === 0 && record.origin === 'agent') return miss(null, null)
    const uri = this._pathToUri(record.path)

    let existed = true
    let tooLarge = false
    let binary = false
    let stamp: BuiltRow['stamp'] = null
    let current = ''
    try {
      const stat = await this._files.stat(uri)
      stamp = { size: stat.size, mtime: stat.mtime, rev }
      if (
        cached !== undefined &&
        record.rev === rev &&
        cached.size === stat.size &&
        cached.mtime === stat.mtime
      ) {
        // Unchanged on disk since the last build — the row is already correct.
        return miss(cached.row, stamp)
      }
      if (!stat.isFile) {
        // A directory (or other non-regular entry) that made it into tracking
        // would otherwise be read on every single recompute, and every read is
        // a guaranteed EISDIR — a permanent error loop that also floods the
        // file system log. Surface it as degraded instead of ever reading it.
        tooLarge = true
        this._logger.debug(`skipping diff of ${record.path} — not a regular file`)
      } else if (await this._isBinary(uri, record.path)) {
        binary = true
      } else if (stat.size > this.maxCurrentBytes) {
        tooLarge = true
        this._logger.debug(
          `skipping diff of ${record.path} — ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds the ${(this.maxCurrentBytes / 1024 / 1024).toFixed(0)}MB read cap`,
        )
      } else if (this._wouldBeDegraded(record, stat.size)) {
        // The per-session cap would release this row's texts on the very pass
        // that read them, so reading is pure waste. See `_wouldBeDegraded`.
        tooLarge = true
        this._logger.debug(
          `skipping diff of ${record.path} — ${(stat.size / 1024 / 1024).toFixed(1)}MB cannot fit the live change budget`,
        )
      } else {
        current = await this._files.readFileText(uri)
      }
    } catch {
      // stat failed, or the read failed after a successful stat. Neither leaves
      // usable content, so the row below reports the file as deleted (as it
      // always has). Dropping the stamp keeps that verdict out of the cache: a
      // transient read failure would otherwise be frozen for as long as the
      // file's size and mtime stayed put.
      existed = false
      stamp = null
    }

    if (tooLarge) {
      // Known-changed but too large to diff: surface a safe degraded row without
      // ever reading the full content into memory.
      return miss(
        {
          uri,
          path: record.path,
          baseline: '',
          current: '',
          status: 'degraded',
          origin: record.origin,
          baselineSource: 'none',
          hasTexts: false,
          batchCount: record.batchCount,
        },
        stamp,
      )
    }
    if (binary) {
      // Compiled intermediate artifacts, object files, archives: never tracked
      // at all (not even as a degraded row). The cached `row: null` above keeps
      // every later pass from re-probing the same unchanged file.
      this._logger.debug(`dropping binary change ${record.path}`)
      return miss(null, stamp)
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
      return miss(null, stamp)
    }

    // Created then deleted → net-zero for the session; drop the row.
    if (!existed && created) return miss(null, stamp)
    // Watched entry with no obtainable baseline and the file already gone —
    // an atomic-write tmp or create-then-delete; net-zero, drop the row.
    if (!existed && source === 'none') return miss(null, stamp)
    // Changed back to the baseline (or rewound) → self-heals out of the list.
    if (source !== 'none' && baseline === current && existed && !created) return miss(null, stamp)

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
    return miss(
      {
        uri,
        path: record.path,
        baseline: effectiveBaseline,
        current,
        status,
        origin: record.origin,
        baselineSource: source,
        // Both texts were read for real on this path — the row may still be
        // `degraded` (imprecise baseline), which is about accuracy, not absence.
        hasTexts: true,
        batchCount: record.batchCount,
      },
      stamp,
    )
  }

  /**
   * Whether the per-session cap is certain to release this row's texts on the
   * pass that would build it — in which case reading the file first is pure
   * waste, since `_capLiveChanges` walks rows heaviest-first and breaks only
   * once it is under budget or the heaviest remaining row is already bare.
   * A row whose own size exceeds the whole budget therefore always degrades.
   *
   * `chars <= bytes`, so the estimate errs toward "too big": a file that might
   * have fit gets a degraded row rather than a read. Skipping the read also skips
   * the self-heal check, which is provably harmless for a pinned baseline — a heal
   * needs `baseline === current`, but a pinned baseline is capped at
   * `maxBaselineBytes` while being skipped needs more than `maxLiveChangeBytes / 2`,
   * so the two can never meet while `maxLiveChangeBytes > 4 * maxBaselineBytes`
   * (true for the defaults). A *reconstructed* baseline is outside that argument:
   * when its hunks cannot be unapplied it comes back equal to `current`, so such a
   * file now sticks as degraded instead of healing out of the list. Saying "changed,
   * not comparable" beats the row vanishing, so that is the trade taken.
   */
  private _wouldBeDegraded(record: FileRecord, size: number): boolean {
    const baselineChars = record.baseline == null ? size : record.baseline.length
    return 2 * (baselineChars + size) > this.maxLiveChangeBytes
  }

  /**
   * Whether this file is binary, per a small head sample. A head read that fails
   * reports "unknown" and the file is let through, matching every other failure
   * path in this tracker: losing a real change is worse than tracking a binary
   * one, and the consequence is bounded by the read caps above.
   */
  private async _isBinary(uri: URI, path: string): Promise<boolean> {
    const binary = await probeIsBinary(this._files, uri)
    if (binary === undefined) {
      this._logger.debug(`binary probe failed for ${path}; treating it as text`)
      return false
    }
    return binary
  }
}

registerSingleton(
  ISessionChangeTrackerService,
  SessionChangeTrackerService,
  InstantiationType.Delayed,
)
