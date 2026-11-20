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
  StorageScope,
  absolutePathToWorkspaceUri,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import { probeIsBinary } from '../../files/binaryDetection.js'
import { IMemoryPressureService } from '../../memory/memoryPressureService.js'
import { MemoryPressureLevel } from '../../memory/memoryPressureLevels.js'
import { reconstructBaseline, type DiffBatch, type DiffHunk } from './sessionDiffReconstruct.js'
import {
  SESSION_CHANGES_BASELINE_CHUNK_CHARS,
  SESSION_CHANGES_ENTRY_GROUP_BYTES,
  SESSION_CHANGES_MAX_ENTRIES_PER_CALL,
  SESSION_CHANGES_MAX_INDEX_ENTRIES,
  ISessionChangesStoreService,
  type SessionChangesBucketInfo,
  type SessionChangesEntryRef,
  type SessionChangesEntryWrite,
  type SessionChangesIndexEntry,
  type SessionChangesShardMeta,
} from '../../../../shared/ipc/sessionChangesStoreService.js'

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
  /** Drain the debounce, any in-flight write and every dirty shard. */
  flush(): Promise<void>
  /**
   * Bytes the tracker is holding across every session, for the heap report's
   * `holders` line — this service has no other reading, and it once climbed from
   * 0.7GB to 5.4GB over two hours until the process was OOM-killed (see the live
   * change budgets above), so its absence from `holders` is the gap that made a
   * repeat unattributable.
   */
  retainedBytes(): { bytes: number; count: number }
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

/** One session's shard payload; the store never sees the other sessions. */
interface PersistedShard {
  readonly schemaVersion: number
  readonly sessionId: string
  readonly files: readonly PersistedFile[]
}

/** One session's pending store write. `rev` gates clearing on completion: a
 *  newer mutation replaces the revision, so an older completion cannot drop the
 *  newer state. `files` is present only for a write retired with an old bucket,
 *  where the in-memory state it came from is already gone. */
interface DirtyWrite {
  readonly rev: number
  readonly files?: Map<string, FileRecord>
}

/** What was last known to be on disk for one file, keyed by path comparison key. */
interface PersistedFileState {
  readonly rev: number
  /** Baseline reference (not just equality) so an unchanged pinned baseline is
   *  never re-sent; `undefined` = no baseline, `null` = created. */
  readonly baseline: string | null | undefined
  /** Generation of the committed body; an unchanged file reuses it instead of
   *  re-sending a body the index already points at. */
  readonly gen: string
  /** Generation of the committed baseline; present exactly when `baseline` is text. */
  readonly baselineGen?: string
}

/** Seed for the persisted cache, installed only when a load is accepted. */
interface PendingCacheSeed {
  readonly label: string
  readonly fingerprint: string
  /** `hadErrors` (from the load that produced the seed) blocks same-bucket reuse:
   *  a session skipped by a failed read must be retried, not frozen out. */
  readonly sessions: Map<string, Map<string, PersistedFileState>>
  readonly hadErrors: boolean
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

/** A manifest fingerprint: any window's write bumps a session's version (or
 *  changes its byte count), so an unchanged fingerprint means the in-memory
 *  state is still a faithful copy of the bucket. JSON of tuples, not string
 *  concatenation, so ids/versions containing separators cannot collide. */
function fingerprintOf(metas: readonly SessionChangesShardMeta[]): string {
  return JSON.stringify(metas.map((m) => [m.sessionId, m.version, m.bytes]))
}

function indexEntryOf(
  key: string,
  rec: FileRecord,
  gen: string,
  baselineGen: string | undefined,
): SessionChangesIndexEntry {
  return {
    key,
    path: rec.path,
    batchCount: rec.batchCount,
    origin: rec.origin,
    gen,
    ...(rec.baseline !== undefined
      ? { baseline: rec.baseline === null ? ('null' as const) : ('text' as const) }
      : {}),
    ...(baselineGen !== undefined ? { baselineGen } : {}),
    ...(rec.baselineSource !== undefined ? { baselineSource: rec.baselineSource } : {}),
    ...(rec.created ? { created: true } : {}),
    ...(rec.ignored ? { ignored: true } : {}),
  }
}

/** Group entries so one IPC call stays near `limit` serialized bytes and never
 *  exceeds `maxCount` entries. A single entry larger than the byte limit is
 *  sent alone (batches are already budgeted). */
function groupByJsonSize<T>(items: readonly T[], limit: number, maxCount: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    const bytes = jsonSize(item)
    if (current.length > 0 && (size + bytes > limit || current.length >= maxCount)) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += bytes
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function splitBaseline(text: string): string[] {
  if (text.length <= SESSION_CHANGES_BASELINE_CHUNK_CHARS) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += SESSION_CHANGES_BASELINE_CHUNK_CHARS) {
    chunks.push(text.slice(i, i + SESSION_CHANGES_BASELINE_CHUNK_CHARS))
  }
  return chunks
}

/** How many file keys one `readEntries` call may ask for. */
const SESSION_CHANGES_ENTRY_READ_BATCH = 16

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

  /**
   * Shard cleanup decided while reading a bucket, applied only when that load is
   * accepted. A reload superseded mid-read must not enqueue writes/removals for
   * a state the base is about to discard (their payloads would target sectors
   * that never entered `_state`).
   */
  private _pendingLoadMutations: { dirty: string[]; removed: string[]; pruned: boolean } | undefined

  /** Bucket handle captured at load time. Every write goes through this handle,
   *  so a workspace swap cannot redirect an in-flight/tail write into the new
   *  workspace's bucket. */
  private _bucket: string | undefined

  /** Diagnostic label of the bound bucket (stable across handle churn). */
  private _bucketLabel: string | undefined

  /**
   * What is known to be persisted, keyed by bucket label → session → file key.
   * The v2 write path sends only files whose revision moved and only baselines
   * whose reference changed, so this cache is what keeps a pinned multi-MB
   * baseline off the wire on every subsequent edit. It is updated only after a
   * session's index commit succeeds; a failed write leaves the session dirty and
   * the cache untouched.
   */
  private readonly _persisted = new Map<string, Map<string, Map<string, PersistedFileState>>>()

  /** Seed for {@link _persisted} from a load that has not been accepted yet. */
  private _pendingCacheSeed: PendingCacheSeed | undefined

  /** State + manifest fingerprint of the last accepted load, for same-bucket reuse. */
  private _lastLoad:
    | {
        readonly label: string
        readonly fingerprint: string
        readonly state: TrackerState
        /** A session was skipped because its read failed; reuse must retry it. */
        readonly hadErrors: boolean
      }
    | undefined

  /** Sessions whose latest snapshot still has to reach the store. */
  private readonly _dirtyWrites = new Map<string, DirtyWrite>()

  /** Sessions removed since the last successful store write. The value is the
   *  same revision counter used by writes: a session removed and re-added
   *  during one write keeps the newer side. */
  private readonly _dirtyRemovals = new Map<string, number>()

  /** Monotonic revision used to tell a stale completion from a newer mutation. */
  private _dirtyRev = 0

  /**
   * Monotonic revision assigned to every file record as it is created or
   * mutated. Persistence compares snapshot revisions for equality, so these must
   * be unique across loads: a reloaded record must never reuse a revision the
   * previous load's cache still holds (that would silently skip its write).
   */
  private _revSeq = 0

  /** Random prefix for body generations. Unique per instance (and thus across
   *  restarts), so a new window can never reuse a generation a committed index
   *  still points at; the counter alone would collide after a restart. */
  private readonly _genPrefix = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  private _genSeq = 0

  /**
   * Writes that belonged to a bucket the window switched away from. They are
   * retried against their own handle; they must never be replayed through the
   * newly bound bucket.
   */
  private readonly _retiredBuckets = new Map<
    string,
    {
      readonly label: string | undefined
      writes: Map<string, DirtyWrite>
      removals: Map<string, number>
    }
  >()

  /** Set when a shard could not be read/parsed: the session is skipped, never
   *  treated as an empty session eligible for deletion. */
  private _loadHadErrors = false

  /**
   * Yield between shard writes so a large dirty set doesn't serialize/encode
   * synchronously in one task. Overridable in tests.
   */
  yieldBetweenPersists: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  /** Per-session index entry cap — overridable in tests. */
  maxIndexEntries = SESSION_CHANGES_MAX_INDEX_ENTRIES
  /** Serialized-byte budget for one entry group — overridable in tests. */
  maxEntryGroupBytes = SESSION_CHANGES_ENTRY_GROUP_BYTES

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _files: IFileService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IMemoryPressureService memoryPressure: IMemoryPressureService,
    @ISessionChangesStoreService private readonly _changesStore: ISessionChangesStoreService,
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
    // Fire-and-forget final drain: the window lifecycle flushes this service
    // through its shutdown participant, but a direct dispose (tests, reload
    // paths) should still try to land the last shard.
    void this.flush().catch(() => undefined)
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

  private _serializeFile(rec: FileRecord): PersistedFile {
    return {
      path: rec.path,
      batches: rec.batches,
      batchCount: rec.batchCount,
      origin: rec.origin,
      ...(rec.baseline !== undefined ? { baseline: rec.baseline } : {}),
      ...(rec.baselineSource !== undefined ? { baselineSource: rec.baselineSource } : {}),
      ...(rec.created ? { created: true } : {}),
      ...(rec.ignored ? { ignored: true } : {}),
    }
  }

  protected _serialize(state: TrackerState): PersistedShape {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessions: [...state.entries()].map(([sessionId, files]) => ({
        sessionId,
        files: [...files.values()].map((rec) => this._serializeFile(rec)),
      })),
    }
  }

  // -- sharded persistence hooks --------------------------------------

  /**
   * Load one session at a time from the bucket the store binds now.
   *
   * A read/parse failure is reported and the session is skipped — it is NOT
   * removed from the bucket and NOT treated as an empty session. Only sessions
   * this pass parsed successfully can be pruned by the size budgets.
   *
   * Same-bucket reloads (workspace scope events for the workspace we already
   * loaded) compare the manifest fingerprint instead of re-reading every shard:
   * the manifest version is bumped by any write, including another window's, so
   * an unchanged fingerprint means the in-memory state is still current.
   */
  protected override async _loadFromStorage(
    _scope: StorageScope,
  ): Promise<TrackerState | undefined> {
    const pending = { dirty: [] as string[], removed: [] as string[], pruned: false }
    this._pendingLoadMutations = pending
    this._pendingCacheSeed = undefined
    let opened: SessionChangesBucketInfo
    try {
      opened = await this._changesStore.openBucket()
      if (opened.importWarning !== undefined) {
        this._logger.warn(
          `session changes bucket ${opened.label}: ${opened.importWarning}; legacy data kept`,
        )
      }
    } catch (err) {
      // No handle means no safe way to write either. Keep the (empty) in-memory
      // state, report, and let a later reload retry; never prune anything.
      this._logger.warn(`failed to open session changes bucket: ${(err as Error).message}`)
      return undefined
    }
    // A different bucket invalidates what we knew was persisted for the old one.
    if (this._bucketLabel !== undefined && this._bucketLabel !== opened.label) {
      this._persisted.delete(this._bucketLabel)
      this._lastLoad = undefined
    }
    this._bucket = opened.handle
    this._bucketLabel = opened.label
    this._loadHadErrors = false

    let metas: readonly SessionChangesShardMeta[]
    try {
      metas = await this._changesStore.list(opened.handle)
    } catch (err) {
      this._logger.warn(`failed to list session change shards: ${(err as Error).message}`)
      this._loadHadErrors = true
      return undefined
    }

    const fingerprint = fingerprintOf(metas)
    const last = this._lastLoad
    // A manifest without versions is the degraded `_scanShards` fallback: byte
    // counts alone cannot prove another window did not rewrite a session, so
    // never reuse state in that case.
    const versioned = metas.every((meta) => typeof meta.version === 'number')
    if (
      versioned &&
      last !== undefined &&
      last.label === opened.label &&
      last.fingerprint === fingerprint &&
      // A session skipped by a failed read is absent from the cached state; reusing
      // it would freeze that session out until some window happens to write.
      !last.hadErrors
    ) {
      // The swap reset `_sessionBytes` via `_onStateReplaced(empty)`; the reused
      // state is unchanged, so rebuild the per-session accounting from its records
      // or the budgets, LRU eviction and `retainedBytes()` stay zeroed forever.
      for (const [sessionId, files] of last.state) {
        let bytes = 0
        for (const rec of files.values()) bytes += recordBytes(rec)
        this._sessionBytes.set(sessionId, bytes)
      }
      // Nothing was written since the state was loaded — reuse it. An empty seed
      // still refreshes the fingerprint recorded for the next reload.
      this._pendingCacheSeed = {
        label: opened.label,
        fingerprint,
        sessions: new Map(),
        hadErrors: false,
      }
      return last.state
    }

    // A full re-read makes the previous cache meaningless. Parsed records get
    // fresh revisions, but sessions left out of the seed (merged pre-load edits,
    // slimmed shards) must not inherit an old cache entry either.
    this._persisted.delete(opened.label)
    this._sessionBytes.clear()
    const state: TrackerState = new Map()
    const seed = new Map<string, Map<string, PersistedFileState>>()
    let total = 0
    let pruned = false
    for (const meta of metas) {
      let read:
        | {
            files: Map<string, FileRecord>
            bytes: number
            v1: boolean
            seed: Map<string, PersistedFileState>
          }
        | undefined
      try {
        read = await this._readSession(opened.handle, meta.sessionId)
      } catch (err) {
        this._loadHadErrors = true
        this._logger.warn(
          `skipping session change shard ${meta.sessionId}: ${(err as Error).message}`,
        )
        continue
      }
      if (read === undefined) {
        // Missing or unreadable: leave whatever is on disk alone. It stays
        // invisible for this run rather than being deleted as "empty".
        this._loadHadErrors = true
        this._logger.warn(`skipping session change shard ${meta.sessionId}: unreadable`)
        continue
      }
      const shrunk = this._shrinkSession(meta.sessionId, read.files, read.bytes)
      if (shrunk === 'drop') {
        pruned = true
        pending.removed.push(meta.sessionId)
        continue
      }
      if (shrunk.slimmed || read.v1) {
        // The shard on disk still holds the dropped batches (or is still the
        // legacy single blob). `_state` has not been published yet, so this
        // cannot use `_markDirty`'s published-state guard — but without a dirty
        // entry the follow-up write drains nothing and the old body survives.
        pruned = true
        pending.dirty.push(meta.sessionId)
      } else {
        seed.set(meta.sessionId, read.seed)
      }
      state.set(meta.sessionId, shrunk.files)
      this._sessionBytes.set(meta.sessionId, shrunk.bytes)
      total += shrunk.bytes
    }
    if (this._enforceLoadBudgets(state, total, this._sessionBytes, pending)) pruned = true
    if (this._loadHadErrors) {
      this._logger.warn('some session change shards could not be read; they were kept untouched')
    }
    if (pruned) {
      pending.pruned = true
      this._logger.warn(
        'pruned session changes to fit the size budgets; slimmed shards will be written',
      )
    }
    this._pendingCacheSeed = {
      label: opened.label,
      fingerprint,
      sessions: seed,
      hadErrors: this._loadHadErrors,
    }
    return state
  }

  /** Read one session as either a v2 index + bodies or a legacy v1 payload. */
  private async _readSession(
    bucket: string,
    sessionId: string,
  ): Promise<
    | {
        files: Map<string, FileRecord>
        bytes: number
        v1: boolean
        /** Committed generations per key; empty for v1 (nothing to reuse). */
        seed: Map<string, PersistedFileState>
      }
    | undefined
  > {
    const read = await this._changesStore.read(bucket, sessionId)
    if (read.status === 'missing') return undefined
    if (read.status === 'error') {
      this._logger.warn(`session change shard ${sessionId} is unreadable: ${read.error}`)
      return undefined
    }
    if (read.format === 'v1') {
      const parsed = this._parseShard(read.payload, sessionId)
      return parsed === undefined
        ? undefined
        : { ...parsed, v1: true, seed: new Map<string, PersistedFileState>() }
    }

    const batches = new Map<string, readonly unknown[]>()
    const refs: SessionChangesEntryRef[] = read.files.map((file) => ({
      key: file.key,
      gen: file.gen,
    }))
    for (let i = 0; i < refs.length; i += SESSION_CHANGES_ENTRY_READ_BATCH) {
      const chunk = refs.slice(i, i + SESSION_CHANGES_ENTRY_READ_BATCH)
      const entries = await this._changesStore.readEntries(bucket, sessionId, chunk)
      if (entries.status !== 'ok') {
        this._logger.warn(
          `session change shard ${sessionId} has unreadable entries: ${
            entries.status === 'missing' ? 'missing file' : entries.error
          }`,
        )
        return undefined
      }
      for (const entry of entries.entries) batches.set(entry.key, entry.batches)
    }

    const persisted: PersistedFile[] = []
    for (const meta of read.files) {
      let baseline: string | null | undefined
      if (meta.baseline === 'text') {
        baseline = await this._readBaseline(bucket, sessionId, meta.key, meta.baselineGen!)
        if (baseline === undefined) return undefined
      } else if (meta.baseline === 'null') {
        baseline = null
      }
      persisted.push({
        path: meta.path,
        batches: (batches.get(meta.key) ?? []) as DiffBatch[],
        batchCount: meta.batchCount,
        origin: meta.origin,
        ...(baseline !== undefined ? { baseline } : {}),
        ...(meta.baselineSource !== undefined ? { baselineSource: meta.baselineSource } : {}),
        ...(meta.created ? { created: true } : {}),
        ...(meta.ignored ? { ignored: true } : {}),
      })
    }
    const parsed = this._parseSession({ sessionId, files: persisted })
    if (parsed === undefined) return undefined
    const seed = new Map<string, PersistedFileState>()
    for (const meta of read.files) {
      const rec = parsed.files.get(meta.key)
      if (rec === undefined) continue
      seed.set(meta.key, {
        rev: rec.rev,
        baseline: rec.baseline,
        gen: meta.gen,
        ...(meta.baselineGen !== undefined ? { baselineGen: meta.baselineGen } : {}),
      })
    }
    return { files: parsed.files, bytes: parsed.bytes, v1: false, seed }
  }

  /** Read a pinned baseline chunk by chunk so no single inbound frame is large. */
  private async _readBaseline(
    bucket: string,
    sessionId: string,
    key: string,
    gen: string,
  ): Promise<string | undefined> {
    const first = await this._changesStore.readBaseline(bucket, sessionId, key, gen, 0)
    if (first.status !== 'ok') {
      this._logger.warn(
        `session change baseline ${sessionId}/${key} is unreadable: ${
          first.status === 'missing' ? 'missing file' : first.error
        }`,
      )
      return undefined
    }
    if (first.count <= 1) return first.text
    const parts = [first.text]
    for (let i = 1; i < first.count; i++) {
      const chunk = await this._changesStore.readBaseline(bucket, sessionId, key, gen, i)
      if (chunk.status !== 'ok') {
        this._logger.warn(`session change baseline ${sessionId}/${key} chunk ${i} is unreadable`)
        return undefined
      }
      parts.push(chunk.text)
    }
    return parts.join('')
  }

  protected override async _persistToStorage(): Promise<void> {
    // Retired buckets first: they belong to a workspace the window already left
    // and must never be replayed through the current handle.
    await this._drainRetiredBuckets()
    if (this._bucket !== undefined) await this._drainBucket(this._bucket, this._bucketLabel)
  }

  protected override async _onBeforeScopeChange(): Promise<void> {
    const bucket = this._bucket
    const label = this._bucketLabel
    if (bucket !== undefined) {
      await this._drainBucket(bucket, label)
      if (this._dirtyWrites.size > 0 || this._dirtyRemovals.size > 0) {
        // The old write failed. Snapshot the records (Map references, not a
        // serialization) and pin them to the old handle so the next scope's
        // writes cannot carry them into the new bucket. A handle reused after
        // switching back may already be retired; merge by revision so the
        // older snapshot's writes are not dropped.
        const writes = new Map<string, DirtyWrite>()
        for (const [sessionId, entry] of this._dirtyWrites) {
          const files = this._combineFiles(entry.files, this._state.get(sessionId))
          writes.set(sessionId, { rev: entry.rev, ...(files !== undefined ? { files } : {}) })
        }
        let retired = this._retiredBuckets.get(bucket)
        if (retired === undefined) {
          retired = { label, writes: new Map(), removals: new Map() }
          this._retiredBuckets.set(bucket, retired)
        }
        this._mergeDirty(retired.writes, retired.removals, writes, this._dirtyRemovals)
      } else {
        // Everything landed; nothing needs this handle anymore, so let main
        // evict the bucket's cached bodies instead of keeping every visited
        // workspace resident until the window closes.
        await this._closeBucket(bucket)
      }
    }
    this._dirtyWrites.clear()
    this._dirtyRemovals.clear()
    this._bucket = undefined
  }

  protected override _onAfterScopeChange(): void {
    // Writes scheduled during the swap (merged pre-load edits, a failed drain
    // pinned to the old bucket) were suppressed; retry them now.
    if (
      this._dirtyWrites.size > 0 ||
      this._dirtyRemovals.size > 0 ||
      this._retiredBuckets.size > 0
    ) {
      this._scheduleWrite()
    }
  }

  /**
   * Merge pre-load edits (records made before `initialize` resolved) with the
   * loaded state. In-memory records win on first-touch fields; the session is
   * moved to the LRU tail and marked dirty so the merge reaches the shard.
   */
  protected override _mergeOnLoad(loaded: TrackerState, current: TrackerState): TrackerState {
    // This hook runs only for an accepted load, so cleanup decided while reading
    // the shards is safe to enqueue now — a superseded read never reaches here.
    const pending = this._pendingLoadMutations
    this._pendingLoadMutations = undefined
    if (pending !== undefined) {
      for (const sessionId of pending.dirty) this._markLoadedDirty(sessionId)
      for (const sessionId of pending.removed) this._markRemoved(sessionId)
      if (pending.pruned) this._prunedOnLoad = true
    }
    // Seed the incremental-write cache only after the load is accepted. Sessions
    // that were merged with pre-load edits (or pruned) are left out so their
    // next write re-sends every entry instead of trusting a stale cache.
    const seed = this._pendingCacheSeed
    this._pendingCacheSeed = undefined
    if (seed !== undefined) {
      const bySession = this._persistedFor(seed.label)
      for (const [sessionId, files] of seed.sessions) {
        if (current.has(sessionId)) continue
        if (pending?.removed.includes(sessionId) === true) continue
        bySession.set(sessionId, files)
      }
      this._lastLoad = {
        label: seed.label,
        fingerprint: seed.fingerprint,
        state: loaded,
        hadErrors: seed.hadErrors,
      }
    }
    if (current.size === 0) return loaded
    for (const [sessionId, incoming] of current) {
      const existing = loaded.get(sessionId)
      if (existing === undefined) {
        loaded.set(sessionId, incoming)
      } else {
        for (const [key, rec] of incoming) {
          const prev = existing.get(key)
          if (prev === undefined) {
            existing.set(key, rec)
            continue
          }
          if (prev.baseline === undefined && rec.baseline !== undefined) {
            prev.baseline = rec.baseline
            if (rec.baselineSource !== undefined) prev.baselineSource = rec.baselineSource
          }
          if (rec.origin === 'agent') {
            prev.origin = 'agent'
            delete prev.ignored
          }
          if (rec.created) prev.created = true
          const known = new Set(prev.batches.map((b) => b.toolCallId))
          for (const batch of rec.batches) {
            if (batch.toolCallId !== undefined && known.has(batch.toolCallId)) {
              const index = prev.batches.findIndex((b) => b.toolCallId === batch.toolCallId)
              if (index >= 0) prev.batches[index] = batch
            } else {
              prev.batches.push(batch)
              prev.batchCount++
            }
          }
          prev.rev = ++this._revSeq
          delete prev.lastBuilt
        }
        // The in-memory session is the most recently active one.
        loaded.delete(sessionId)
        loaded.set(sessionId, existing)
      }
      let bytes = 0
      for (const rec of loaded.get(sessionId)!.values()) bytes += recordBytes(rec)
      this._sessionBytes.set(sessionId, bytes)
      this._markDirty(sessionId)
    }
    return loaded
  }

  /** Parse a shard payload; unknown schema/version is reported by the caller. */
  private _parseShard(
    payload: unknown,
    expectedSessionId: string,
  ): { files: Map<string, FileRecord>; bytes: number } | undefined {
    if (payload === null || typeof payload !== 'object') return undefined
    const shard = payload as Partial<PersistedShard>
    if (shard.schemaVersion !== SCHEMA_VERSION) return undefined
    if (shard.sessionId !== expectedSessionId) return undefined
    if (!Array.isArray(shard.files)) return undefined
    const parsed = this._parseSession({ sessionId: expectedSessionId, files: shard.files })
    return parsed === undefined ? undefined : { files: parsed.files, bytes: parsed.bytes }
  }

  private _parseSession(s: unknown): { files: Map<string, FileRecord>; bytes: number } | undefined {
    if (!s || typeof s !== 'object') return undefined
    const session = s as { sessionId?: unknown; files?: unknown }
    if (typeof session.sessionId !== 'string' || !Array.isArray(session.files)) return undefined
    const files = new Map<string, FileRecord>()
    let bytes = 0
    for (const f of session.files) {
      if (!f || typeof f !== 'object') continue
      const pf = f as PersistedFile
      // A corrupt shard must cost its bad entries, not the whole bucket load.
      // `path` is used as a map key, and `baseline` flows into diff texts.
      if (typeof pf.path !== 'string' || pf.path.length === 0) continue
      if (pf.baseline !== undefined && pf.baseline !== null && typeof pf.baseline !== 'string') {
        continue
      }
      const batches = Array.isArray(pf.batches) ? [...pf.batches] : []
      const rec: FileRecord = {
        path: pf.path,
        batches,
        batchCount: typeof pf.batchCount === 'number' ? pf.batchCount : batches.length,
        origin: pf.origin === 'watched' ? 'watched' : 'agent',
        rev: ++this._revSeq,
        ...(pf.baseline !== undefined ? { baseline: pf.baseline } : {}),
        ...(pf.baselineSource === 'reported' || pf.baselineSource === 'git'
          ? { baselineSource: pf.baselineSource }
          : {}),
        ...(pf.created ? { created: true } : {}),
        ...(pf.ignored ? { ignored: true } : {}),
      }
      const key = this._pathKey(pf.path)
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
    return { files, bytes }
  }

  private _shrinkSession(
    sessionId: string,
    files: Map<string, FileRecord>,
    bytes: number,
  ): { files: Map<string, FileRecord>; bytes: number; slimmed: boolean } | 'drop' {
    if (bytes <= this.maxSessionBytes) return { files, bytes, slimmed: false }
    // Try the graceful degradation first: batches are rollback data only.
    for (const rec of files.values()) rec.batches = []
    let slimmed = 0
    for (const rec of files.values()) slimmed += recordBytes(rec)
    if (slimmed <= this.maxSessionBytes) return { files, bytes: slimmed, slimmed: true }
    this._logger.warn(
      `pruning session ${sessionId} on load — ${(slimmed / 1024 / 1024).toFixed(1)}MB exceeds the per-session budget`,
    )
    return 'drop'
  }

  private _enforceLoadBudgets(
    state: TrackerState,
    total: number,
    sessionBytes: Map<string, number>,
    pending?: { removed: string[] },
  ): boolean {
    let pruned = false
    // Serialized order is append order (oldest first) — evict from the front.
    while (state.size > this.maxTrackedSessions || total > this.maxTotalBytes) {
      const oldest = state.keys().next().value
      if (oldest === undefined) break
      total -= sessionBytes.get(oldest) ?? 0
      state.delete(oldest)
      sessionBytes.delete(oldest)
      if (pending !== undefined) pending.removed.push(oldest)
      else this._markRemoved(oldest)
      pruned = true
    }
    return pruned
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
      const parsed = this._parseSession(s)
      if (parsed === undefined) {
        pruned = true
        continue
      }
      const sessionId = (s as { sessionId: string }).sessionId
      const shrunk = this._shrinkSession(sessionId, parsed.files, parsed.bytes)
      if (shrunk === 'drop') {
        pruned = true
        continue
      }
      if (shrunk.slimmed) {
        pruned = true
        this._markLoadedDirty(sessionId)
      }
      state.set(sessionId, shrunk.files)
      this._sessionBytes.set(sessionId, shrunk.bytes)
      total += shrunk.bytes
    }
    if (this._enforceLoadBudgets(state, total, this._sessionBytes)) pruned = true
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
    // Pre-load edits merged in, or a write that had no bucket yet.
    if (this._dirtyWrites.size > 0 || this._dirtyRemovals.size > 0) this._scheduleWrite()
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
    this._markDirty(sessionId)
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
    this._markDirty(sessionId)
    this._scheduleWrite()
    this._scheduleRecompute(sessionId)
  }

  dismissWatched(sessionId: string, path: string): void {
    const files = this._state.get(sessionId)
    const rec = files?.get(this._pathKey(path))
    if (!rec || rec.origin !== 'watched' || rec.ignored) return
    rec.ignored = true
    this._markDirty(sessionId)
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
    this._dropSessionCache(this._bucketLabel, sessionId)
    this._markRemoved(sessionId)
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

  /**
   * Two structures, both resident, so both count: `_sessionBytes` is the serialized
   * records (pinned baselines and buffered batches), `_liveChangeBytes` the diff rows
   * currently parked in the observables. Counting only one would report a session
   * holding GB of live texts as holding nothing.
   */
  retainedBytes(): { bytes: number; count: number } {
    let bytes = 0
    for (const b of this._sessionBytes.values()) bytes += b
    for (const b of this._liveChangeBytes.values()) bytes += b
    return { bytes, count: this._sessionBytes.size }
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

  /** Snapshot one session for the next store write. Only dirty sessions are
   *  serialized/sent — never the whole state; the payload itself is built
   *  immediately before that session's write, not here. */
  private _markDirty(sessionId: string): void {
    if (!this._state.has(sessionId)) return
    this._markLoadedDirty(sessionId)
  }

  /**
   * Mark a session for the next drain without the published-state check above:
   * load-time pruning decides the slimmed shape while `_state` still holds the
   * previous scope's map, so the session is not there yet.
   */
  private _markLoadedDirty(sessionId: string): void {
    this._dirtyRev++
    this._dirtyRemovals.delete(sessionId)
    this._dirtyWrites.set(sessionId, { rev: this._dirtyRev })
  }

  private _markRemoved(sessionId: string): void {
    this._dirtyRev++
    this._dirtyWrites.delete(sessionId)
    this._dirtyRemovals.set(sessionId, this._dirtyRev)
  }

  private async _drainBucket(bucket: string, label: string | undefined): Promise<void> {
    await this._drainEntries(bucket, label, this._dirtyWrites, this._dirtyRemovals)
  }

  /**
   * Write/remove everything in the given maps through `bucket`, one session at
   * a time with a yield in between. Entries mutated while a write is in flight
   * carry a newer revision and stay behind for the follow-up write; a failure
   * also stays behind. Neither case can ever be cleared by a stale completion.
   */
  private async _drainEntries(
    bucket: string,
    label: string | undefined,
    writes: Map<string, DirtyWrite>,
    removals: Map<string, number>,
  ): Promise<void> {
    for (const [sessionId, rev] of [...removals]) {
      if (removals.get(sessionId) !== rev) continue
      try {
        await this._changesStore.remove(bucket, sessionId)
      } catch (err) {
        this._logger.warn(
          `failed to remove session change shard ${sessionId}: ${(err as Error).message}`,
        )
        continue
      }
      if (removals.get(sessionId) === rev) removals.delete(sessionId)
      this._dropSessionCache(label, sessionId)
      await this.yieldBetweenPersists()
    }
    for (const [sessionId, entry] of [...writes]) {
      // Superseded by a newer mutation while this drain was running.
      if (writes.get(sessionId) !== entry) continue
      // A retired snapshot may carry files the reloaded live state no longer
      // has; the live record wins where both exist.
      const files = this._combineFiles(entry.files, this._state.get(sessionId))
      if (files === undefined) continue
      const ok = await this._writeSession(bucket, label, sessionId, files)
      if (ok && writes.get(sessionId) === entry) writes.delete(sessionId)
      await this.yieldBetweenPersists()
    }
  }

  /** A fresh body generation: instance-random prefix + monotonic base36 counter. */
  private _nextGen(): string {
    return `${this._genPrefix}${(++this._genSeq).toString(36)}`
  }

  /**
   * Write one session: only the entries whose revision moved, only baselines
   * whose reference changed, then the index. The cache is updated only after
   * the commit succeeds, so a failed write is retried in full next time.
   */
  private async _writeSession(
    bucket: string,
    label: string | undefined,
    sessionId: string,
    files: Map<string, FileRecord>,
  ): Promise<boolean> {
    const cache = label !== undefined ? this._persisted.get(label)?.get(sessionId) : undefined
    // The index is one IPC frame. Above the shared cap, drop the first-touched
    // files (map insertion order — records are appended on first sight and never
    // reordered) instead of sending a write main would reject forever. A session
    // with six figures of changed files is already far outside any useful rewind
    // history.
    if (files.size > this.maxIndexEntries) {
      let drop = files.size - this.maxIndexEntries
      this._logger.warn(
        `dropping ${drop} first-touched tracked file(s) for session ${sessionId} — index limit ${this.maxIndexEntries}`,
      )
      for (const key of files.keys()) {
        if (drop <= 0) break
        files.delete(key)
        drop--
      }
      // The dropped records were counted in `_sessionBytes`; leaving them there
      // would keep the global budget over-reporting (and evicting live sessions).
      // A retired snapshot is not the live map and has no such account.
      if (this._state.get(sessionId) === files) {
        let bytes = 0
        for (const rec of files.values()) bytes += recordBytes(rec)
        this._sessionBytes.set(sessionId, bytes)
      }
      this._requestRecompute(sessionId)
    }
    const index: SessionChangesIndexEntry[] = []
    const changed: SessionChangesEntryWrite[] = []
    const baselines: Array<{ readonly key: string; readonly gen: string; readonly text: string }> =
      []
    // Snapshot exactly what this write sends. A `record()` landing while a
    // sub-call is on the wire bumps `rev`; the cache must then not be seeded
    // with the newer record, or the follow-up write would believe it is persisted.
    const snapshot = new Map<string, PersistedFileState>()
    for (const [key, rec] of files) {
      const cached = cache?.get(key)
      const bodyChanged = cached === undefined || cached.rev !== rec.rev
      const gen = bodyChanged ? this._nextGen() : cached.gen
      const baselineChanged =
        typeof rec.baseline === 'string' &&
        (cached === undefined ||
          cached.baseline !== rec.baseline ||
          cached.baselineGen === undefined)
      const baselineGen =
        typeof rec.baseline === 'string'
          ? baselineChanged
            ? this._nextGen()
            : cached!.baselineGen!
          : undefined
      snapshot.set(key, {
        rev: rec.rev,
        baseline: rec.baseline,
        gen,
        ...(baselineGen !== undefined ? { baselineGen } : {}),
      })
      index.push(indexEntryOf(key, rec, gen, baselineGen))
      if (bodyChanged) {
        changed.push({ key, gen, batches: rec.batches })
      }
      if (baselineChanged) {
        baselines.push({ key, gen: baselineGen!, text: rec.baseline as string })
      }
    }

    for (const group of groupByJsonSize(
      changed,
      this.maxEntryGroupBytes,
      SESSION_CHANGES_MAX_ENTRIES_PER_CALL,
    )) {
      try {
        const result = await this._changesStore.writeEntries(bucket, sessionId, group)
        if (!result.ok) {
          this._logger.warn(
            `failed to persist session change entries ${sessionId}: ${result.error}`,
          )
          return false
        }
      } catch (err) {
        this._logger.warn(
          `failed to persist session change entries ${sessionId}: ${(err as Error).message}`,
        )
        return false
      }
    }

    for (const baseline of baselines) {
      const chunks = splitBaseline(baseline.text)
      for (let i = 0; i < chunks.length; i++) {
        try {
          const result = await this._changesStore.writeBaseline(
            bucket,
            sessionId,
            baseline.key,
            baseline.gen,
            {
              index: i,
              count: chunks.length,
              text: chunks[i]!,
            },
          )
          if (!result.ok) {
            this._logger.warn(
              `failed to persist session change baseline ${sessionId}/${baseline.key}: ${result.error}`,
            )
            return false
          }
        } catch (err) {
          this._logger.warn(
            `failed to persist session change baseline ${sessionId}/${baseline.key}: ${(err as Error).message}`,
          )
          return false
        }
      }
    }

    try {
      const result = await this._changesStore.commitIndex(bucket, sessionId, index)
      if (!result.ok) {
        this._logger.warn(`failed to commit session change index ${sessionId}: ${result.error}`)
        return false
      }
    } catch (err) {
      this._logger.warn(
        `failed to commit session change index ${sessionId}: ${(err as Error).message}`,
      )
      return false
    }

    if (label !== undefined) {
      let stillCurrent = files.size === snapshot.size
      if (stillCurrent) {
        for (const [key, written] of snapshot) {
          const rec = files.get(key)
          if (rec === undefined || rec.rev !== written.rev || rec.baseline !== written.baseline) {
            stillCurrent = false
            break
          }
        }
      }
      // A record landed while this write was on the wire: leave the cache
      // untouched so the follow-up write re-sends the superseded entries.
      if (stillCurrent) this._persistedFor(label).set(sessionId, snapshot)
    }
    return true
  }

  private _persistedFor(label: string): Map<string, Map<string, PersistedFileState>> {
    let bySession = this._persisted.get(label)
    if (!bySession) {
      bySession = new Map()
      this._persisted.set(label, bySession)
    }
    return bySession
  }

  private _dropSessionCache(label: string | undefined, sessionId: string): void {
    if (label === undefined) return
    this._persisted.get(label)?.delete(sessionId)
  }

  private async _drainRetiredBuckets(): Promise<void> {
    for (const [bucket, entries] of [...this._retiredBuckets]) {
      await this._drainEntries(bucket, entries.label, entries.writes, entries.removals)
      if (entries.writes.size > 0 || entries.removals.size > 0) {
        // Still failing; if this handle is also the bucket we are writing
        // through now, the next pass must retry these through it rather than
        // keep a retired copy that can never drain.
        if (bucket === this._bucket) {
          this._retiredBuckets.delete(bucket)
          this._mergeDirty(this._dirtyWrites, this._dirtyRemovals, entries.writes, entries.removals)
        }
        continue
      }
      this._retiredBuckets.delete(bucket)
      // Re-opening the workspace reuses its handle. Closing it here would drop
      // the handle the tracker is actively writing through.
      if (bucket !== this._bucket) await this._closeBucket(bucket)
    }
  }

  /** Rev-aware merge of a retired snapshot into another dirty map pair. */
  private _mergeDirty(
    targetWrites: Map<string, DirtyWrite>,
    targetRemovals: Map<string, number>,
    writes: ReadonlyMap<string, DirtyWrite>,
    removals: ReadonlyMap<string, number>,
  ): void {
    for (const [sessionId, rev] of removals) {
      const write = targetWrites.get(sessionId)
      if (write !== undefined && write.rev <= rev) targetWrites.delete(sessionId)
      const current = targetRemovals.get(sessionId)
      if (current === undefined || rev > current) targetRemovals.set(sessionId, rev)
    }
    for (const [sessionId, entry] of writes) {
      const removal = targetRemovals.get(sessionId)
      if (removal !== undefined && removal > entry.rev) continue
      if (removal !== undefined) targetRemovals.delete(sessionId)
      const current = targetWrites.get(sessionId)
      // A retired snapshot and the live state can each hold files the other
      // does not (the snapshot predates this bucket's reload); the newer side
      // wins per path, never the whole map.
      const files = this._combineFiles(current?.files, entry.files)
      const rev = Math.max(entry.rev, current?.rev ?? -1)
      targetWrites.set(sessionId, { rev, ...(files !== undefined ? { files } : {}) })
    }
  }

  private _combineFiles(
    older: Map<string, FileRecord> | undefined,
    newer: Map<string, FileRecord> | undefined,
  ): Map<string, FileRecord> | undefined {
    if (older === undefined) return newer
    if (newer === undefined || newer === older) return older
    const merged = new Map(older)
    for (const [key, rec] of newer) merged.set(key, rec)
    return merged
  }

  /** Best-effort: the store releases the bucket's cached bodies on last close. */
  private async _closeBucket(bucket: string): Promise<void> {
    try {
      await this._changesStore.closeBucket(bucket)
    } catch (err) {
      this._logger.warn(`failed to close session changes bucket: ${(err as Error).message}`)
    }
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
      this._dropSessionCache(this._bucketLabel, oldest)
      this._markRemoved(oldest)
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
      this._markDirty(sessionId)
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
    rec.rev = ++this._revSeq
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
