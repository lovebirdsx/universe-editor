/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Custom implementation inspired by VSCode's log system (platform/log/common/log.ts).
 *  VSCode's version is tightly coupled to platform services; this is a self-contained
 *  simplified implementation.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { ILogChannel } from './loggerService.js'

/**
 * One-time snapshot of the global console methods, taken at module load before
 * any interceptor can patch them. Loggers and crash-path code use these to
 * avoid recursing into the interceptor (which would call back into a logger
 * that just failed to write).
 */
const ORIGINAL_CONSOLE: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
}

/** Returns the pre-interceptor console methods. Use from logger fallbacks. */
export function getOriginalConsole(): typeof ORIGINAL_CONSOLE {
  return ORIGINAL_CONSOLE
}

export const enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

export function canLog(logger: ILogger, level: LogLevel): boolean {
  return logger.level !== LogLevel.Off && level >= logger.level
}

export interface ILogger extends IDisposable {
  readonly level: LogLevel
  readonly onDidChangeLogLevel: Event<LogLevel>
  setLevel(level: LogLevel): void

  trace(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string | Error, ...args: unknown[]): void
  flush(): void
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ILogService extends ILogger {}

export const ILogService = createDecorator<ILogService>('logService')

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  return String(arg)
}

function formatArgs(args: unknown[]): string {
  return args.length > 0 ? ` ${args.map(formatArg).join(' ')}` : ''
}

/**
 * Base class for loggers. Subclasses only need to implement `_log(level, message)`.
 * Checks level before formatting to avoid unnecessary work.
 */
export abstract class AbstractLogger extends Disposable implements ILogger {
  private _level: LogLevel
  private readonly _onDidChangeLogLevel = this._register(new Emitter<LogLevel>())
  readonly onDidChangeLogLevel: Event<LogLevel> = this._onDidChangeLogLevel.event

  constructor(level: LogLevel = LogLevel.Info) {
    super()
    this._level = level
  }

  get level(): LogLevel {
    return this._level
  }

  setLevel(level: LogLevel): void {
    if (this._level === level) return
    this._level = level
    this._onDidChangeLogLevel.fire(level)
  }

  trace(message: string, ...args: unknown[]): void {
    if (canLog(this, LogLevel.Trace)) {
      this._log(LogLevel.Trace, message + formatArgs(args))
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (canLog(this, LogLevel.Debug)) {
      this._log(LogLevel.Debug, message + formatArgs(args))
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (canLog(this, LogLevel.Info)) {
      this._log(LogLevel.Info, message + formatArgs(args))
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (canLog(this, LogLevel.Warning)) {
      this._log(LogLevel.Warning, message + formatArgs(args))
    }
  }

  error(message: string | Error, ...args: unknown[]): void {
    if (canLog(this, LogLevel.Error)) {
      const msg = message instanceof Error ? (message.stack ?? message.message) : message
      this._log(LogLevel.Error, msg + formatArgs(args))
    }
  }

  flush(): void {
    // default no-op; subclasses may override for buffered loggers
  }

  protected abstract _log(level: LogLevel, message: string): void
}

/**
 * No-op logger; useful as a default when no logging is desired.
 */
export class NullLogger extends AbstractLogger {
  protected _log(_level: LogLevel, _message: string): void {}
}

/**
 * Helper for the common pattern: optional `ILoggerService` injection plus a
 * fallback to NullLogger when no service is wired (e.g. in tests).
 */
export function createNamedLogger(
  service: { createLogger(channel: ILogChannel): ILogger } | undefined,
  channel: ILogChannel,
): ILogger {
  return service?.createLogger(channel) ?? new NullLogger()
}

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warn',
  [LogLevel.Error]: 'error',
}

/** Supported timestamp format tokens for log output. */
export type LogTimestampFormat = 'HH:mm:ss' | 'HH:mm:ss.SSS' | 'ISO'

export const LOG_TIMESTAMP_FORMAT_DEFAULT: LogTimestampFormat = 'HH:mm:ss'

/** Format a Date for log output according to the given format string. */
export function formatLogTimestamp(date: Date, format: string): string {
  if (format === 'ISO') return date.toISOString()
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  if (format === 'HH:mm:ss.SSS') {
    return `${h}:${m}:${s}.${String(date.getMilliseconds()).padStart(3, '0')}`
  }
  return `${h}:${m}:${s}`
}

/**
 * Logs to `console`. Suitable for development environments.
 */
export class ConsoleLogger extends AbstractLogger {
  protected _log(level: LogLevel, message: string): void {
    const label = LOG_LEVEL_LABELS[level] ?? 'log'
    const timestamp = formatLogTimestamp(new Date(), LOG_TIMESTAMP_FORMAT_DEFAULT)
    const line = `[${timestamp}] [${label}] ${message}`

    // Always go through the captured originals so MultiplexLogger setups
    // (renderer dev mode mirrors logs to console) cannot recurse via an
    // installed console interceptor.
    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        ORIGINAL_CONSOLE.debug(line)
        break
      case LogLevel.Info:
        ORIGINAL_CONSOLE.info(line)
        break
      case LogLevel.Warning:
        ORIGINAL_CONSOLE.warn(line)
        break
      case LogLevel.Error:
        ORIGINAL_CONSOLE.error(line)
        break
    }
  }
}

/**
 * Multiplexes log calls to multiple loggers. Forwards level changes to all delegates.
 */
export class MultiplexLogger extends AbstractLogger {
  private readonly _loggers: ILogger[]

  constructor(loggers: ILogger[], level?: LogLevel) {
    super(level)
    this._loggers = loggers
  }

  override setLevel(level: LogLevel): void {
    super.setLevel(level)
    for (const logger of this._loggers) {
      logger.setLevel(level)
    }
  }

  protected _log(level: LogLevel, message: string): void {
    for (const logger of this._loggers) {
      if (canLog(logger, level)) {
        switch (level) {
          case LogLevel.Trace:
            logger.trace(message)
            break
          case LogLevel.Debug:
            logger.debug(message)
            break
          case LogLevel.Info:
            logger.info(message)
            break
          case LogLevel.Warning:
            logger.warn(message)
            break
          case LogLevel.Error:
            logger.error(message)
            break
        }
      }
    }
  }

  override flush(): void {
    for (const logger of this._loggers) {
      logger.flush()
    }
  }

  override dispose(): void {
    for (const logger of this._loggers) {
      logger.dispose()
    }
    super.dispose()
  }
}
