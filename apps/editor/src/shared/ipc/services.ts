/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for editor-specific cross-process services. Generic services
 *  (host, storage) live in @universe-editor/platform; this file holds only the
 *  app-local additions. Both main (server) and renderer (client via ProxyChannel)
 *  import these symbols so the channel surface stays in lock-step at the type
 *  level.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event, LogLevel, PerformanceMark } from '@universe-editor/platform'

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

// -------- API Usage (main reads ~/.claude/settings.json + queries provider) --------

/** Per-model usage breakdown for the current day. Monetary fields are raw integers. */
export interface UsageModelUsage {
  readonly model: string
  readonly requests: number
  readonly rawTokens: number
  /** Raw integer cost; divide by 10000 for the CNY amount. */
  readonly costCny: number
}

/**
 * A successfully-fetched usage snapshot. Monetary fields keep the provider's raw
 * integer scale (divide by 10000 for the CNY amount); formatting is the
 * renderer's job so the wire contract stays presentation-agnostic.
 */
export interface UsageSnapshot {
  readonly date: string
  readonly periodBucket: string
  readonly periodUsedCny: number
  readonly periodLimitCny: number
  readonly periodRemainingCny: number
  readonly requests: number
  readonly rawTokens: number
  readonly models: readonly UsageModelUsage[]
}

/**
 * Result of an API-usage query. A discriminated union so the renderer can react
 * distinctly: `disabled` (credentials missing — hide the indicator entirely),
 * `ok` (snapshot), or `error` (show an error glyph + reason tooltip).
 */
export type UsageResult =
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'ok'; readonly snapshot: UsageSnapshot }
  | { readonly kind: 'error'; readonly message: string }

export interface IUsageService {
  readonly _serviceBrand: undefined
  getUsage(): Promise<UsageResult>
}

export const IUsageService = createDecorator<IUsageService>('usageService')

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
