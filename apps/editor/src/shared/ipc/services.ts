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
 * Each renderer window sends structured log entries; the main process writes them to disk.
 */
export interface ILogChannelService {
  readonly _serviceBrand: undefined
  append(
    windowId: number,
    channel: string,
    level: LogLevel,
    message: string,
    timestamp: number,
  ): Promise<void>
  appendBatch(windowId: number, entries: readonly LogEntry[]): Promise<void>
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
}

export interface LogAppendEvent {
  readonly channelId: string
  readonly chunk: string
  readonly maxLevel: LogLevel
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

export type DisposableLeakSource = 'restart' | 'close' | 'quit' | 'unknown'

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
  /** Reads the pending report (if any) and deletes the file. */
  consumePendingReport(): Promise<IDisposableLeakReport | null>
}

export const IDisposableLeakService =
  createDecorator<IDisposableLeakService>('disposableLeakService')

// -------- Performance Marks (main -> renderer startup timing) --------

/**
 * Exposes the main process's performance marks to the renderer so the timer
 * service can merge both processes' marks into a single startup timeline.
 * Read-only and generic: any future main-side perf instrumentation surfaces here.
 */
export interface IPerformanceMarksService {
  readonly _serviceBrand: undefined
  getMarks(): Promise<PerformanceMark[]>
}

export const IPerformanceMarksService =
  createDecorator<IPerformanceMarksService>('performanceMarksService')
