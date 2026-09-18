/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for editor-specific cross-process services. Generic services
 *  (host, storage) live in @universe-editor/platform; this file holds only the
 *  app-local additions. Both main (server) and renderer (client via ProxyChannel)
 *  import these symbols so the channel surface stays in lock-step at the type
 *  level.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  Event,
  IssueReportPayload,
  IssueReportProviderInfo,
  LogLevel,
  PerformanceMark,
} from '@universe-editor/platform'

// -------- Ping (demo/smoke-test) --------

export interface PingResult {
  pong: true
  rendererSentAt: number
  mainReceivedAt: number
}

export interface IPingService {
  readonly _serviceBrand: undefined
  ping(rendererSentAt: number): Promise<PingResult>
}

export const IPingService = createDecorator<IPingService>('pingService')

// -------- Log Channel (renderer → main aggregation) --------

export interface LogEntry {
  readonly channel: string
  readonly level: LogLevel
  readonly message: string
  readonly timestamp: number
}

/**
 * Wire-only IPC contract for renderer-side logging.
 * Each renderer window sends structured log entries; the main process writes
 * them to disk. The source window is the authoritative BrowserWindow id the main
 * receiver already holds, so it is never sent over the wire.
 */
export interface ILogChannelService {
  readonly _serviceBrand: undefined
  append(channel: string, level: LogLevel, message: string, timestamp: number): Promise<void>
  appendBatch(entries: readonly LogEntry[]): Promise<void>
}

export const ILogChannelService = createDecorator<ILogChannelService>('logChannelService')

// -------- Log Files (main -> renderer read-only log viewing) --------

export interface LogFileDescriptor {
  readonly id: string
  readonly name: string
  readonly channelId: string
  /** Human-readable timestamp (YYYY-MM-DD HH:mm:ss) of when the current session was started. */
  readonly sessionStartedAt: string
  readonly size: number
  readonly modifiedTime: number
  /** Source window for private renderer logs; absent for shared main-process channels. */
  readonly windowId?: number
}

export interface LogAppendEvent {
  readonly channelId: string
  readonly chunk: string
  readonly maxLevel: LogLevel
  /** Source window for renderer entries; absent for shared main-process entries. */
  readonly windowId?: number
}

export interface ILogFilesService {
  readonly _serviceBrand: undefined
  readonly onDidAppendEntry: Event<LogAppendEvent>
  listLogFiles(): Promise<LogFileDescriptor[]>
  readLogFile(id: string, maxBytes?: number): Promise<string>
  resolveLogPath(id: string): Promise<string>
  openLogsFolder(): Promise<void>
  setLogLevel(level: LogLevel): Promise<void>
  getLogLevel(): Promise<LogLevel>
  setTimestampFormat(format: string): Promise<void>
  getTimestampFormat(): Promise<string>
}

export const ILogFilesService = createDecorator<ILogFilesService>('logFilesService')

// -------- Disposable Leak Report (renderer -> main persistence across sessions) --------

export type DisposableLeakSource = 'reload' | 'close' | 'quit' | 'unknown'

export interface IDisposableLeakReport {
  readonly count: number
  readonly details: string
  readonly capturedAt: number
  readonly source: DisposableLeakSource
}

/**
 * Dev-only service that persists the previous session's Disposable leak report
 * to disk so the next renderer bootstrap can surface it as a notification.
 * sessionStorage is insufficient because window close/app quit creates a new
 * BrowserWindow whose sessionStorage is empty.
 */
export interface IDisposableLeakService {
  readonly _serviceBrand: undefined
  reportLeaks(report: IDisposableLeakReport): Promise<void>
  /**
   * Prints the leak report to the `pnpm dev` terminal (node stdout) without
   * persisting it. Renderer console output never reaches that terminal, so this
   * is the only bridge for surfacing renderer leaks there, on par with main.
   */
  printLeaks(report: IDisposableLeakReport): Promise<void>
  /** Reads the pending report (if any) and deletes the file. */
  consumePendingReport(): Promise<IDisposableLeakReport | null>
}

export const IDisposableLeakService =
  createDecorator<IDisposableLeakService>('disposableLeakService')

// -------- Performance Marks (main -> renderer startup timing) --------

/**
 * Whether this launch is the first run of a freshly installed version, plus the
 * version it replaced. Lets the renderer tag its startup-timing log so a slow
 * post-update first launch (antivirus first-scanning the new exe/asar) is
 * distinguishable from steady-state launches after the fact.
 */
export interface StartupContext {
  readonly postUpdate: boolean
  readonly currentVersion: string
  readonly previousVersion?: string
}

/** One startup timeline the renderer hands back to the main log after mount. */
export interface StartupTimingReport {
  /** Total time from the earliest mark (process created) to workbench mount, ms. */
  readonly totalTime: number
  /** Process created → first main-process JS line, ms; undefined if unavailable. */
  readonly preJsGapMs?: number
  /** True when the window load was a reload — the timeline spans the reload only. */
  readonly isReload?: boolean
  /** Adjacent-milestone phases: label → duration ms. */
  readonly phases: ReadonlyArray<{ readonly label: string; readonly duration: number }>
}

/**
 * Exposes the main process's performance marks to the renderer so the timer
 * service can merge both processes' marks into a single startup timeline.
 * Read-only and generic: any future main-side perf instrumentation surfaces here.
 */
export interface IPerformanceMarksService {
  readonly _serviceBrand: undefined
  getMarks(): Promise<PerformanceMark[]>
  /** Whether this launch is a post-update first run (see StartupContext). */
  getStartupContext(): Promise<StartupContext>
  /** Persist one startup timeline to the shared main log (called once, first window). */
  reportStartupTiming(report: StartupTimingReport): Promise<void>
}

export const IPerformanceMarksService =
  createDecorator<IPerformanceMarksService>('performanceMarksService')

// -------- Exchange Rate (main fetches USD→CNY rate, caches to disk) --------

export interface ExchangeRateResult {
  /** 1 USD = `rate` CNY. */
  readonly rate: number
  /** 'live' = freshly fetched or cached from network; 'fallback' = hardcoded constant because network never succeeded. */
  readonly source: 'live' | 'fallback'
  /** Unix epoch ms when the rate was fetched. */
  readonly fetchedAt: number
}

export interface IExchangeRateService {
  readonly _serviceBrand: undefined
  /** Returns USD→CNY rate. Cached on disk; only hits the network once per day. */
  getUsdToCnyRate(): Promise<ExchangeRateResult>
}

export const IExchangeRateService = createDecorator<IExchangeRateService>('exchangeRateService')

// -------- Error Sink (renderer → main structured error records → errors.jsonl) --------

/**
 * One structured error occurrence (already fingerprinted, dedup-merged and
 * redacted by the producer). `source` / `appVersion` are NOT on the wire: the
 * main receiver stamps them authoritatively (per-window wrapper knows the
 * BrowserWindow id) so a renderer cannot forge another window's records.
 */
export interface WireErrorRecord {
  readonly v: 1
  /** Epoch ms of the latest occurrence folded into this record. */
  readonly ts: number
  /** Event name, e.g. 'unhandledError'. */
  readonly event: string
  /** Stable short fingerprint (`func@file`) for grouping across sessions. */
  readonly fingerprint: string
  /** How many occurrences this record folds. */
  readonly count: number
  /** Redacted message (first line). */
  readonly message: string
  /** Redacted stack, when available. */
  readonly stack?: string
  /** Producer's session id (renderer bootstrap uuid / main session id). */
  readonly sessionId: string
  /** Extra scalar dimensions supplied by the reporter (e.g. acp sessionId, agent kind). */
  readonly dimensions?: { readonly [key: string]: string | number | boolean }
}

/**
 * Receives structured error records from any process and persists them to
 * `<userData>/logs/<session>/errors.jsonl`. Main-process errors are recorded
 * through the same implementation (see ErrorSinkMainService.recordLocal).
 */
export interface IErrorSinkService {
  readonly _serviceBrand: undefined
  ingestErrors(records: readonly WireErrorRecord[]): Promise<void>
}

export const IErrorSinkService = createDecorator<IErrorSinkService>('errorSinkService')

// -------- Diagnostics (abnormal-exit report, crash dumps, system info) --------

/**
 * A resident holder of large strings inside the renderer, measured on the same
 * overhead-adjusted scale the holder's own budget already uses. Reported next to the
 * heap sample so a crash package can answer "who was holding the 3GB" rather than only
 * "the heap was 3GB" — the dumps show 92-97% of it in `lo_space`, i.e. giant strings.
 */
export interface WireHeapHolder {
  readonly name: string
  readonly bytes: number
  /** Entries held, when a count says something the byte total does not. */
  readonly count?: number
}

/**
 * Work the renderer did between two samples, read-then-clear on the reporting side.
 * Distinct from `holders`: a holder is bytes still resident, a flow entry is bytes
 * churned through — which is how a renderer reaches 2GB without ever holding 2GB.
 */
export interface WireHeapFlow {
  readonly name: string
  readonly calls: number
  readonly chars: number
}

/** An absolute reading of something the V8 heap number cannot see. */
export interface WireHeapGauge {
  readonly name: string
  readonly value: number
}

/**
 * A population the renderer knows exactly (live sessions, registered resident-budget
 * holders, pooled agent connections). Kept apart from `gauge` on purpose: a count of
 * zero is a reading and has to survive to the log line, whereas a gauge reading zero
 * is dropped as noise — and "0 sessions" and "this build has no session service" must
 * not collapse into the same absent field.
 */
export interface WireHeapCount {
  readonly name: string
  readonly value: number
}

/**
 * One renderer heap reading. Only the renderer can see its own V8 heap, and it can die
 * mid-crash — so the window id and the receive time are stamped by main, which is what
 * lets the record outlive the window it describes.
 */
export interface WireRendererHeapSample {
  readonly used: number
  readonly limit: number
  /** Watermark level name: normal | elevated | critical. */
  readonly level: string
  readonly holders: readonly WireHeapHolder[]
  /** Omitted when no counted work happened during the interval. */
  readonly flow?: readonly WireHeapFlow[]
  /** Omitted when every gauge reads zero. */
  readonly gauge?: readonly WireHeapGauge[]
  /** Omitted when no population could be read (not when one reads zero). */
  readonly counts?: readonly WireHeapCount[]
  /**
   * Regenerated on every renderer start. Main compares it against the incarnation it
   * already bound to the window: a sample from a different one cannot be part of the
   * same baseline, because it describes a different JS heap.
   */
  readonly incarnation?: string
}

/** Structured form of the previous session's abnormal exit (sentinel + crashpad). */
export interface AbnormalExitInfo {
  readonly previousSessionId: string
  readonly previousStartedAt: number
  /** Last sentinel heartbeat — the session died within one interval after this. */
  readonly previousLastAliveAt: number
  /** Absolute paths of crash dumps written since the previous session started. */
  readonly crashDumps: readonly string[]
}

/**
 * Diagnostics facade. The abnormal-exit report has consume-once semantics: the
 * first window to ask surfaces the notification, later windows get null (same
 * pattern as IDisposableLeakService.consumePendingReport).
 */
export interface IDiagnosticsService {
  readonly _serviceBrand: undefined
  consumeAbnormalExitReport(): Promise<AbnormalExitInfo | null>
  /** Reveal the crash-dump directory (or the newest dump in it) in the OS shell. */
  revealCrashesFolder(): Promise<void>
  /**
   * Build the markdown diagnostics summary (versions / system info / extensions /
   * top error fingerprints from errors.jsonl) for the Report Issue flow.
   */
  collectIssueReport(): Promise<string>
  /**
   * Write a diagnostics zip (sysinfo + recent errors.jsonl + tail of recent
   * session logs + crash-dump listing) under <userData>/diagnostics/, reveal it
   * in the OS shell, and return its absolute path.
   */
  exportDiagnosticsZip(): Promise<string>
  /**
   * Same zip as exportDiagnosticsZip but without the OS-shell reveal — used by
   * main-internal consumers (the tracker issue reporter uploads it as an
   * attachment).
   */
  createDiagnosticsZip(): Promise<string>
  /**
   * One renderer heap reading. Goes to main's processMetrics channel — which is written
   * by a process that does not crash with the renderer, so the growth curve survives it —
   * and into a small ring that the diagnostics zip ships as `memory.txt`.
   */
  reportRendererHeapSample(sample: WireRendererHeapSample): Promise<void>
  /**
   * Arm a round for the calling window. Idempotent; never resets the round's budget.
   * Default off, never persisted, never enabled by workspace settings: taking a
   * snapshot freezes this renderer for seconds to tens of seconds (measured: ~15–19 ms
   * per MB of live heap) and the artifact contains whatever strings that heap held, so
   * only the person in front of this window can start one.
   */
  startHeapSnapshotRound(): Promise<HeapSnapshotStatus>
  /** Stop new captures for the calling window. An in-flight capture cannot be cancelled. */
  stopHeapSnapshotRound(): Promise<HeapSnapshotStatus>
  getHeapSnapshotStatus(): Promise<HeapSnapshotStatus>
  /** Open the snapshot directory (created on demand) in the OS shell. */
  revealHeapSnapshotsFolder(): Promise<void>
  /** Round reports for this window only; main filters, so nothing crosses windows. */
  readonly onDidChangeHeapSnapshot: Event<HeapSnapshotEvent>
}

export const IDiagnosticsService = createDecorator<IDiagnosticsService>('diagnosticsService')

// -------- Controlled heap snapshots (user-enabled, local-only) --------

/** Which of the two snapshots of a round a file is. */
export type HeapSnapshotTrigger = 'baseline' | 'growth'

/**
 * Why a round did nothing, ended, or waits. Stable ids, not prose: main sends the id
 * plus numeric measurements, and the window renders the sentence in the user's
 * language. A code that carries no text would silently produce a blank notification,
 * so the renderer maps every member (the coverage test for that map is what keeps the
 * two sides in step).
 */
export type HeapSnapshotNoticeCode =
  /** The window never reported a usable V8 heap limit, so no capture size is derivable. */
  | 'heap-limit-unknown'
  /** The heap is already above what a baseline is allowed to cost. */
  | 'baseline-too-large'
  /** Samples moved more than the baseline band allows — the heap is not settled enough. */
  | 'baseline-unstable'
  /** The newest sample is older than the freshness bound; the window stopped reporting. */
  | 'sample-stale'
  /** Known holders account for the majority of the rise; a snapshot would not add a lead. */
  | 'holders-explain'
  /** The heap is past the capture ceiling, so the artifact would exceed what was agreed. */
  | 'heap-too-large'
  /** Nothing left below the capture ceiling; a growth snapshot could never stay under it. */
  | 'capture-limit-reached'
  | 'physical-memory-low'
  | 'commit-headroom-low'
  /** No fresh commit reading on a platform that has commit accounting. */
  | 'commit-unknown'
  | 'disk-space-low'
  /** The free-space reading itself failed; refusing to guess. */
  | 'disk-unknown'
  /** The snapshot directory is at its size/count budget; the user has to clean it up. */
  | 'directory-budget'
  | 'capture-failed'
  /** The capture has not returned within the timeout — reported, not cancelled. */
  | 'capture-stalled'
  /** The app-wide attempt budget for this run is spent. */
  | 'app-quota-exhausted'
  /** This round's attempts are spent. */
  | 'round-quota-exhausted'
  /** A round lasts at most 2 hours. */
  | 'round-expired'
  /** Both snapshots of the round are on disk. */
  | 'round-complete'
  | 'window-closed'
  | 'window-reloaded'
  /** The window is still open but its renderer is not running (crashed). Not the same as closed. */
  | 'renderer-unavailable'
  | 'stopped-by-user'
  /** The calling window has no live renderer to snapshot. */
  | 'no-target'

/** What the round is doing right now, for the window that owns it. */
export type HeapSnapshotPhase =
  /** No round is armed (the default; enabling is never persisted). */
  | 'off'
  /** Collecting the samples a baseline has to be stable across. */
  | 'baseline'
  /** Baseline captured; watching post-baseline samples for a sustained rise. */
  | 'watching'
  /** A capture is in flight for this window (an unrecoverable state to interrupt). */
  | 'capturing'
  /** A round ran and ended; the reason is in `code`. */
  | 'stopped'

export interface HeapSnapshotArtifactInfo {
  /** File name only — main generates it and never hands out the directory to renderers. */
  readonly name: string
  readonly bytes: number
  readonly trigger: HeapSnapshotTrigger
}

export type HeapSnapshotEventKind =
  /** A round was armed for this window. */
  | 'started'
  /** A snapshot finished and was renamed into place. */
  | 'captured'
  /** A decision skipped or a capture is taking longer than expected. */
  | 'notice'
  /** An attempt failed; the round ends (no repeat freeze). */
  | 'failed'
  /** The round ended. */
  | 'stopped'

/**
 * One report for the window that owns the round. Main stamps `windowId` and filters on
 * it per window, so window A's diagnostics can never surface a toast in window B.
 */
export interface HeapSnapshotEvent {
  readonly windowId: number
  /** Monotonic per window. The renderer drops anything at or below what it has shown. */
  readonly revision: number
  readonly at: number
  readonly kind: HeapSnapshotEventKind
  readonly code?: HeapSnapshotNoticeCode
  /** Measurements only (counts, durations, megabytes) — never paths or snapshot content. */
  readonly detail?: string
  readonly artifact?: HeapSnapshotArtifactInfo
}

export interface HeapSnapshotStatus {
  /** True while a round is armed for this window. */
  readonly active: boolean
  readonly phase: HeapSnapshotPhase
  readonly startedAt?: number
  /** A round lasts at most this long; armed rounds stop at the deadline. */
  readonly expiresAt?: number
  /** Actual capture calls made this round (failures included). */
  readonly attempts: number
  readonly attemptLimit: number
  /** Actual capture calls made since the app started; stopping a round does not reset it. */
  readonly appAttempts: number
  readonly appAttemptLimit: number
  /** Snapshot files this round wrote. */
  readonly artifacts: number
  readonly bytes: number
  /** The last decision, so a window that just mounted can say what is going on. */
  readonly code?: HeapSnapshotNoticeCode
  readonly detail?: string
}

/**
 * The heap-snapshot half of the diagnostics facade is documented on the members
 * declared with the rest of {@link IDiagnosticsService} above; the types below are
 * what crosses the wire.
 */

// -------- Issue Reporter (pluggable Report Issue targets) --------

/**
 * Facade over the pluggable issue-report providers (GitHub / tracker) held by
 * the main process. The renderer collects the markdown, asks the chosen
 * provider for a pre-filled issue-page URL (uploading the diagnostics zip
 * first when `attachDiagnostics`), then opens that URL itself.
 */
export interface IIssueReporterService {
  readonly _serviceBrand: undefined
  listProviders(): Promise<IssueReportProviderInfo[]>
  /** Throws on unknown provider id or when the attachment upload fails. */
  buildIssueUrl(providerId: string, payload: IssueReportPayload): Promise<string>
}

export const IIssueReporterService = createDecorator<IIssueReporterService>('issueReporterService')
