/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILoggerService: factory for named, multi-channel loggers.
 *  Main-process implementations write to disk; renderer-side routes via IPC.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { ILogger, LogLevel } from './log.js'

/** Descriptor identifying a log channel (a named destination). */
export interface ILogChannel {
  /** Stable identifier, e.g. 'main', 'renderer-1', 'editor'. */
  readonly id: string
  /** Human-readable label shown in the Output panel. */
  readonly name: string
}

/**
 * Factory service for creating per-channel loggers.
 * Implementations may write to files, the console, an IPC bridge, etc.
 */
export interface ILoggerService {
  readonly _serviceBrand: undefined

  /** Create (or retrieve) an ILogger for the given channel descriptor. */
  createLogger(channel: ILogChannel): ILogger

  /** Change the log level for all loggers created by this service. */
  setLevel(level: LogLevel): void

  /** Current log level applied to new loggers. */
  getLevel(): LogLevel
}

export const ILoggerService = createDecorator<ILoggerService>('loggerService')
