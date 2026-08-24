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
   * main-internal consumers (the iLoop issue reporter uploads it as an
   * attachment).
   */
  createDiagnosticsZip(): Promise<string>
}

export const IDiagnosticsService = createDecorator<IDiagnosticsService>('diagnosticsService')

// -------- Issue Reporter (pluggable Report Issue targets) --------

/**
 * Facade over the pluggable issue-report providers (GitHub / iLoop) held by
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
