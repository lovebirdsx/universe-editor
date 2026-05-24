/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contracts for editor-specific cross-process services. Generic services
 *  (host, storage) live in @universe-editor/platform; this file holds only the
 *  app-local additions. Both main (server) and renderer (client via ProxyChannel)
 *  import these symbols so the channel surface stays in lock-step at the type
 *  level.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event, LogLevel } from '@universe-editor/platform'

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
