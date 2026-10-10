/**
 * The sync history: one record per get the editor ran, kept as an append-only
 * event stream under the extension's `globalStoragePath`.
 *
 * Deliberately a SEPARATE file from `graphSyncLedger.json`, and the two never
 * read each other. The ledger answers "where has this scope got to?" — one
 * deduplicated record per scope, where an older answer is retired by a newer
 * claim (`contradictedBy`). The history answers "what did the last runs do?" —
 * every run leaves exactly one record, INCLUDING the runs the ledger must not
 * record (cancelled, failed, unrecognized, refused at the scope gate). Merging
 * them would mean one file with two contradictory retention rules.
 *
 * The persisted entry is a plain JSON event; a corrupted or hand-edited file is
 * tolerated the same way the ledger tolerates one (bad entries are dropped, a
 * fully unreadable file starts empty), and a failed write costs one record.
 * Nothing here may throw into the extension host: `record` runs on the sync
 * teardown path, where an escaping exception becomes an uncaughtException that
 * kills every extension (CLAUDE.md red line 4).
 *
 * Facts this module cannot observe (engine, IO bytes, parallel threads) ride in
 * on {@link SyncRunFacts}, snapshotted by `PerforceClient.sync` — the only place
 * that knows them — and handed over on the run's `SyncRunResult`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  P4SyncCountsDto,
  P4SyncRunDetailDto,
  P4SyncRunDto,
  P4SyncRunScopeDto,
} from '@universe-editor/extensions-common'
import { stampOf } from './graphSyncLedger.js'
import { scopeKey } from './pathUtil.js'
import type { SyncScopeTarget } from './p4Filespec.js'
import { syncNothingHappened, type SyncRunSummary } from './syncParser.js'

const FILE_NAME = 'syncHistory.json'

/**
 * Upper bound on records; oldest `at` loses. One get writes one entry, so a long
 * session over a big tree would otherwise grow this without bound. Same order of
 * magnitude as the ledger's cap, and deliberately not configurable — the file
 * stays a few tens of KB and nobody has to tune it.
 */
const MAX_ENTRIES = 200

/**
 * Per-entry scope cap. `scope` is display data here (unlike the ledger, where it
 * IS the identity), so a get over a thousand-file selection may be truncated —
 * {@link SyncHistoryEntry.scopeOmitted} keeps the count honest.
 */
const MAX_SCOPE_PATHS = 64

/** Scope entries the list DTO carries per row; the detail DTO has them all. */
const SCOPE_FIRST = 3

/** Page size `getRuns` falls back to when the caller names none — the
 *  contract's documented default, kept here so the two cannot drift. */
export const DEFAULT_RUNS_PAGE = 50

/** Where a get was started from. Each `runSync` call site must declare one. */
export type SyncHistoryTrigger =
  | 'statusBar'
  | 'explorer'
  | 'graph'
  | 'timeline'
  | 'command'
  | 'recovery'

/**
 * How a get ended. The first four describe a run p4 participated in; `declined`
 * is the one outcome of a call that never spawned anything (the user refused at
 * the scope gate), recorded so "I clicked get and nothing happens" leaves a
 * trace.
 */
export type SyncHistoryOutcome =
  | 'applied'
  | 'upToDate'
  | 'unrecognized'
  | 'failed'
  | 'cancelled'
  | 'declined'

/** The engine that served the run. */
export type SyncHistoryEngine = 'p4delta' | 'p4'

/** The six per-file counts, copied off {@link SyncRunSummary}. */
export interface SyncHistoryCounts {
  readonly applied: number
  readonly refusedModified: number
  readonly refusedOverwrite: number
  readonly keptOpen: number
  readonly mustResolve: number
  readonly handoff: number
}

/**
 * What only `PerforceClient.sync` can observe about a run, snapshotted before
 * the sync teardown clears the counters (`_endExternalSuspend` →
 * `_stopSyncIoProbes` zeroes the byte totals).
 *
 * Known approximations, carried into the UI verbatim:
 * - `io` is the p4 process tree's read/write byte counters — network receive
 *   plus local staging on the read side, workspace writes plus staging on the
 *   write side. An approximation, not a network/disk split. Absent = no sampler
 *   ran (macOS, no PowerShell/WMI, a sampler that died, a transient failure that
 *   discarded its samples), which is NOT the same as zero bytes.
 * - Overlapping syncs share one set of counters (see `SyncProgress`), so a run
 *   that overlapped another reports the sum of both.
 * - `diskWrites` counts working-tree watcher events, a LOWER BOUND: each push is
 *   truncated at 5000 events and `files.watcherExclude` applies, and there may be
 *   no watcher at all (remote workspace).
 * - Sampling is once a second, so a run shorter than a tick can carry a sampler
 *   yet zero bytes.
 */
export interface SyncRunFacts {
  readonly engine: SyncHistoryEngine
  /** True when δ was attempted and handed this run to native p4. */
  readonly engineFallback: boolean
  /** `perforce.syncParallelThreads` in force for this run (0 = serial). */
  readonly parallelThreads: number
  readonly startedAt: number
  readonly endedAt: number
  readonly io?: { readonly readBytes: number; readonly writeBytes: number }
  readonly diskWrites: number
}

/** One get, as persisted. */
export interface SyncHistoryEntry {
  /** `${at}-${pid}-${seq}` — what `getRun` addresses. */
  readonly id: string
  /** When the run settled (or the gate was declined), epoch ms; the sort key. */
  readonly at: number
  readonly startedAt: number
  readonly durationMs: number
  /** Client root the get ran against; entries never answer for another client's
   *  path identity (the same discipline the ledger keeps). */
  readonly clientRoot: string
  /** The revision suffix as passed to p4, never re-derived: `#head`, `@4521`,
   *  `#4`, `@2026/08/01`, or `''` for a per-file get. */
  readonly spec: string
  readonly force: boolean
  readonly trigger: SyncHistoryTrigger
  readonly outcome: SyncHistoryOutcome
  /** Host paths + directory-ness — the range the get actually covered. NOT
   *  filespecs: those are post-escaping, post-`<dir>/...` artifacts that cannot
   *  be compared or displayed as paths (same reason the ledger stores host
   *  paths). Truncated to {@link MAX_SCOPE_PATHS}. */
  readonly scope: readonly SyncScopeTarget[]
  /** Scope entries dropped by the cap. */
  readonly scopeOmitted: number
  /** The scope gate narrowed the user's selection to the daily scope. */
  readonly scopeNarrowed: boolean
  readonly engine?: SyncHistoryEngine
  readonly engineFallback?: boolean
  readonly parallelThreads?: number
  readonly counts?: SyncHistoryCounts
  /** Absent = no sampler for this run; never render as 0. */
  readonly io?: { readonly readBytes: number; readonly writeBytes: number }
  /** Lower bound (watcher events); absent when no run was observed at all. */
  readonly diskWrites?: number
  readonly error?: { readonly kind: string; readonly message: string }
}

/**
 * The slice of `SyncRunResult` this module reads. Structural on purpose: the
 * client imports {@link SyncRunFacts} from here, so naming the concrete type
 * would close an import cycle for no benefit.
 */
export interface SyncRunHistoryInput {
  readonly ok: boolean
  readonly cancelled: boolean
  readonly summary: SyncRunSummary | undefined
  readonly error: { readonly kind: string; readonly suggestion: string } | undefined
  readonly facts?: SyncRunFacts
  /** The editor refused the get before any engine ran it (see
   *  `SyncRunResult.notRun`). */
  readonly notRun?: boolean
}

/** Process-unique id generator: two runs can settle in the same millisecond (a
 *  fast up-to-date get right after another), and the pid separates windows. */
let idSeq = 0
export function nextSyncHistoryId(at: number): string {
  idSeq += 1
  return `${at}-${process.pid}-${idSeq}`
}

/**
 * Classify a settled run. `'declined'` means the get never ran: the scope gate
 * was declined, or the editor's own pre-flight refused the range
 * ({@link SyncRunHistoryInput.notRun}) — neither is a p4 outcome, and the
 * refusal's reason rides on `error` rather than on a synthesized failure.
 *
 * Order matters: `notRun` outranks `ok`, so a refusal that never spawned
 * anything cannot be misread as a failure of a process that never existed; a
 * cancellation is the user's doing, not a failure, so it outranks `ok` (a
 * killed p4 exits nonzero); an `!ok` run outranks the summary (a clobber
 * refusal leaves a summary-shaped stdout that must not read as applied); and
 * "nothing happened" splits on p4's own up-to-date line, which arrives on
 * stderr with exit 0.
 */
export function outcomeOfRun(run: SyncRunHistoryInput | undefined): SyncHistoryOutcome {
  if (run === undefined) return 'declined'
  if (run.notRun === true) return 'declined'
  if (run.cancelled) return 'cancelled'
  if (!run.ok) return 'failed'
  if (syncNothingHappened(run.summary)) {
    return run.summary?.upToDate === true ? 'upToDate' : 'unrecognized'
  }
  return 'applied'
}

export interface BuildSyncHistoryInput {
  readonly id: string
  /** When the run settled, epoch ms. */
  readonly at: number
  readonly clientRoot: string
  readonly spec: string
  readonly force: boolean
  readonly trigger: SyncHistoryTrigger
  /** The range the get covered, as the call site named it. */
  readonly scope: readonly SyncScopeTarget[]
  readonly scopeNarrowed: boolean
  readonly outcome: SyncHistoryOutcome
  readonly run: SyncRunHistoryInput | undefined
}

/** Shape one run into a record. Pure.
 *
 *  The clock is the RUN's, never the caller's: a run that reported facts stamps
 *  its own start ({@link SyncRunFacts.startedAt}), and one that has none to
 *  report never ran — a declined get is the only such case, and its duration is
 *  0 because there is no get to time. */
export function buildSyncHistoryEntry(input: BuildSyncHistoryInput): SyncHistoryEntry {
  const declined = input.outcome === 'declined'
  const facts = input.run?.facts
  const startedAt = declined ? input.at : (facts?.startedAt ?? input.at)
  const summary = input.run?.summary
  const error = input.run?.error
  const scope = input.scope.slice(0, MAX_SCOPE_PATHS)
  return {
    id: input.id,
    at: input.at,
    startedAt,
    // A declined run's zero is structural, not a measurement: any span here
    // could only cover a dialog the user was reading (the scope gate, the
    // client's own refusal toast) or the same-ms skew between the call and the
    // record. Neither is transfer time.
    durationMs: declined ? 0 : Math.max(0, input.at - startedAt),
    clientRoot: input.clientRoot,
    spec: input.spec,
    force: input.force,
    trigger: input.trigger,
    outcome: input.outcome,
    scope,
    scopeOmitted: input.scope.length - scope.length,
    scopeNarrowed: input.scopeNarrowed,
    ...(facts !== undefined
      ? {
          engine: facts.engine,
          engineFallback: facts.engineFallback,
          parallelThreads: facts.parallelThreads,
          ...(facts.io !== undefined ? { io: facts.io } : {}),
          diskWrites: facts.diskWrites,
        }
      : {}),
    ...(summary !== undefined ? { counts: countsOf(summary) } : {}),
    ...(error !== undefined ? { error: { kind: error.kind, message: error.suggestion } } : {}),
  }
}

function countsOf(summary: SyncRunSummary): SyncHistoryCounts {
  return {
    applied: summary.applied,
    refusedModified: summary.refusedModified,
    refusedOverwrite: summary.refusedOverwrite,
    keptOpen: summary.keptOpen,
    mustResolve: summary.mustResolve,
    handoff: summary.handoff,
  }
}

const TRIGGERS: readonly string[] = [
  'statusBar',
  'explorer',
  'graph',
  'timeline',
  'command',
  'recovery',
]
const OUTCOMES: readonly string[] = [
  'applied',
  'upToDate',
  'unrecognized',
  'failed',
  'cancelled',
  'declined',
]
const ENGINES: readonly string[] = ['p4delta', 'p4']

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

function isScopeTarget(value: unknown): value is SyncScopeTarget {
  if (value === null || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t['path'] === 'string' && t['path'].length > 0 && typeof t['isDirectory'] === 'boolean'
  )
}

function isCounts(value: unknown): value is SyncHistoryCounts {
  if (value === null || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    isCount(c['applied']) &&
    isCount(c['refusedModified']) &&
    isCount(c['refusedOverwrite']) &&
    isCount(c['keptOpen']) &&
    isCount(c['mustResolve']) &&
    isCount(c['handoff'])
  )
}

function isIo(value: unknown): value is { readBytes: number; writeBytes: number } {
  if (value === null || typeof value !== 'object') return false
  const io = value as Record<string, unknown>
  return isCount(io['readBytes']) && isCount(io['writeBytes'])
}

/**
 * A record must be shaped like one this module writes; anything else is
 * dropped rather than trusted. The file is plain JSON in a directory other
 * tools can reach, so one hand-written line must not be able to crash a read
 * or fabricate a run.
 */
export function isEntry(value: unknown): value is SyncHistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  if (typeof e['id'] !== 'string' || e['id'].length === 0) return false
  if (!isCount(e['at']) || !isCount(e['startedAt']) || !isCount(e['durationMs'])) return false
  if (typeof e['clientRoot'] !== 'string' || e['clientRoot'].length === 0) return false
  if (typeof e['spec'] !== 'string') return false
  if (typeof e['force'] !== 'boolean') return false
  if (typeof e['trigger'] !== 'string' || !TRIGGERS.includes(e['trigger'])) return false
  if (typeof e['outcome'] !== 'string' || !OUTCOMES.includes(e['outcome'])) return false
  // The module's own cap, not just the entry shape: a hand-written (or
  // legacy) record with a huge scope would otherwise be served out on every
  // read and carried along by every later record() merge-write.
  if (!Array.isArray(e['scope']) || e['scope'].length > MAX_SCOPE_PATHS) return false
  if (!e['scope'].every(isScopeTarget)) return false
  if (!isCount(e['scopeOmitted'])) return false
  if (typeof e['scopeNarrowed'] !== 'boolean') return false
  if (e['engine'] !== undefined && !ENGINES.includes(e['engine'] as string)) return false
  if (e['engineFallback'] !== undefined && typeof e['engineFallback'] !== 'boolean') return false
  if (e['parallelThreads'] !== undefined && !isCount(e['parallelThreads'])) return false
  if (e['counts'] !== undefined && !isCounts(e['counts'])) return false
  if (e['io'] !== undefined && !isIo(e['io'])) return false
  if (e['diskWrites'] !== undefined && !isCount(e['diskWrites'])) return false
  const err = e['error']
  if (err !== undefined) {
    if (err === null || typeof err !== 'object') return false
    const r = err as Record<string, unknown>
    if (typeof r['kind'] !== 'string' || typeof r['message'] !== 'string') return false
  }
  return true
}

function toScopeDto(target: SyncScopeTarget): P4SyncRunScopeDto {
  return { path: target.path, isDirectory: target.isDirectory }
}

function toCountsDto(counts: SyncHistoryCounts): P4SyncCountsDto {
  return { ...counts }
}

/** Project a record onto the list DTO: the scope is trimmed to
 *  {@link SCOPE_FIRST} with the full size alongside, so a page of 200 rows
 *  stays small. Pure. */
export function toRunDto(entry: SyncHistoryEntry): P4SyncRunDto {
  return {
    id: entry.id,
    at: entry.at,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    clientRoot: entry.clientRoot,
    spec: entry.spec,
    force: entry.force,
    trigger: entry.trigger,
    outcome: entry.outcome,
    ...(entry.engine !== undefined ? { engine: entry.engine } : {}),
    ...(entry.engineFallback !== undefined ? { engineFallback: entry.engineFallback } : {}),
    ...(entry.parallelThreads !== undefined ? { parallelThreads: entry.parallelThreads } : {}),
    ...(entry.counts !== undefined ? { counts: toCountsDto(entry.counts) } : {}),
    ...(entry.io !== undefined ? { io: { ...entry.io } } : {}),
    ...(entry.diskWrites !== undefined ? { diskWrites: entry.diskWrites } : {}),
    ...(entry.error !== undefined ? { error: { ...entry.error } } : {}),
    scopeNarrowed: entry.scopeNarrowed,
    scopeFirst: entry.scope.slice(0, SCOPE_FIRST).map(toScopeDto),
    scopeCount: entry.scope.length + entry.scopeOmitted,
  }
}

/** Project a record onto the detail DTO: the complete scope. Pure. */
export function toRunDetailDto(entry: SyncHistoryEntry): P4SyncRunDetailDto {
  return {
    ...toRunDto(entry),
    scope: entry.scope.map(toScopeDto),
    scopeOmitted: entry.scopeOmitted,
  }
}

/** A page of records, newest first. */
export interface SyncHistoryPage {
  readonly entries: readonly SyncHistoryEntry[]
  /** Matching entries in total, before the page cut. */
  readonly total: number
  readonly hasMore: boolean
}

export interface SyncHistoryListOptions {
  /** Only entries of this client root (host path identity via `scopeKey`). */
  readonly root?: string
  readonly max: number
}

interface SyncHistoryFile {
  version: number
  entries: SyncHistoryEntry[]
}

function parseHistory(raw: string): SyncHistoryEntry[] {
  try {
    const parsed = JSON.parse(raw) as Partial<SyncHistoryFile>
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(isEntry)
  } catch {
    return []
  }
}

function readEntries(file: string): SyncHistoryEntry[] {
  if (!existsSync(file)) return []
  try {
    return parseHistory(readFileSync(file, 'utf8'))
  } catch {
    // Unreadable — start empty. The next record rewrites the file.
    return []
  }
}

/**
 * The history file. One instance per window (each extension host has its own),
 * all pointing at the same path; `list`/`get` re-read when the file moved so a
 * second window's runs show up without a restart.
 */
export class SyncHistoryLog {
  /** mtime+size of the file the in-memory copy came from, so a read can tell
   *  that another window wrote since. */
  private _stamp: string | undefined

  private constructor(
    private readonly _file: string,
    private _entries: SyncHistoryEntry[],
    private readonly _log?: (msg: string) => void,
  ) {
    this._stamp = stampOf(_file)
  }

  /**
   * Open (or create) the history under `root` — the extension's
   * `globalStoragePath`. Returns undefined when there is no storage configured
   * or the directory cannot be created, so callers degrade to "never records".
   */
  static open(root: string, log?: (msg: string) => void): SyncHistoryLog | undefined {
    if (!root) return undefined
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      return undefined
    }
    const file = join(root, FILE_NAME)
    return new SyncHistoryLog(file, readEntries(file), log)
  }

  /** Path of the backing file, for log lines and tests. */
  get file(): string {
    return this._file
  }

  /**
   * Append one run. Read-modify-write like the ledger: entries are small and
   * gets are rare, so re-reading beats the bookkeeping a real merge would need.
   * Two windows writing at the same instant lose one entry, never a wrong one —
   * deliberate, rather than locking a file that is written once per sync.
   *
   * Synchronous on purpose: this runs on the sync teardown path, before any
   * dialog is awaited, so the duration it records cannot absorb the user's
   * reading time. Never throws (red line 4).
   */
  record(entry: SyncHistoryEntry): void {
    try {
      const merged = readEntries(this._file)
      const next = merged.filter((e) => e.id !== entry.id)
      next.push(entry)
      // Sort then trim, so the cap drops the oldest RECORDED runs rather than
      // the first-written ones (a rewound clock or a delayed write must not let
      // a stale entry evict a fresh one).
      next.sort((a, b) => a.at - b.at)
      while (next.length > MAX_ENTRIES) next.shift()
      this._entries = next
      this._flush()
    } catch (err) {
      this._warn(`[perforce] sync history write failed: ${(err as Error).message}`)
    }
  }

  /** A page of entries, newest first. Zero p4 calls. */
  list(options: SyncHistoryListOptions): SyncHistoryPage {
    this._reloadIfChanged()
    const requested = Number.isFinite(options.max) ? Math.floor(options.max) : 1
    const max = Math.max(1, requested)
    const rootKey = options.root !== undefined ? scopeKey(options.root) : undefined
    const all = [...this._entries].sort((a, b) => b.at - a.at)
    const matching =
      rootKey === undefined ? all : all.filter((e) => scopeKey(e.clientRoot) === rootKey)
    const entries = matching.slice(0, max)
    return { entries, total: matching.length, hasMore: matching.length > entries.length }
  }

  get(id: string): SyncHistoryEntry | undefined {
    this._reloadIfChanged()
    return this._entries.find((e) => e.id === id)
  }

  /**
   * Take another window's writes into account. Every window runs its own
   * extension host with its own copy of this object, and the point of the
   * file's location is that they share one history — a copy loaded at activate
   * would hide every run the other window made for as long as it lives.
   */
  private _reloadIfChanged(): void {
    const stamp = stampOf(this._file)
    if (stamp === this._stamp) return
    this._entries = readEntries(this._file)
    this._stamp = stamp
  }

  /** Never lets the log sink throw back: this runs on the sync teardown path,
   *  where an escaping exception becomes an uncaughtException (red line 4). */
  private _warn(msg: string): void {
    try {
      this._log?.(msg)
    } catch {
      // The sink is not ours to trust.
    }
  }

  private _flush(): void {
    const payload: SyncHistoryFile = { version: 1, entries: this._entries }
    // Per-process temp name: two windows writing at the same moment would
    // otherwise share one `.tmp`, and whoever renames second would either
    // publish the other's bytes under its own stamp or fail outright.
    const tmp = `${this._file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this._file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this._file)
      this._stamp = stampOf(this._file)
    } catch (err) {
      this._warn(`[perforce] sync history write failed: ${(err as Error).message}`)
    }
  }
}
