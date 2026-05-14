/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Custom implementation inspired by VSCode's log system (platform/log/common/log.ts).
 *  VSCode's version is tightly coupled to platform services; this is a self-contained
 *  simplified implementation.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

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

function formatArgs(args: unknown[]): string {
  return args.length > 0 ? ` ${args.map((a) => String(a)).join(' ')}` : ''
}

/**
 * Base class for loggers. Subclasses only need to implement `_log(level, message)`.
 * Checks level before formatting to avoid unnecessary work.
 */
export abstract class AbstractLogger extends Disposable implements ILogger {
  private _level: LogLevel

  constructor(level: LogLevel = LogLevel.Info) {
    super()
    this._level = level
  }

  get level(): LogLevel {
    return this._level
  }

  setLevel(level: LogLevel): void {
    this._level = level
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

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warn',
  [LogLevel.Error]: 'error',
}

/**
 * Logs to `console`. Suitable for development environments.
 */
export class ConsoleLogger extends AbstractLogger {
  protected _log(level: LogLevel, message: string): void {
    const label = LOG_LEVEL_LABELS[level] ?? 'log'
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${label}] ${message}`

    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        console.debug(line)
        break
      case LogLevel.Info:
        console.info(line)
        break
      case LogLevel.Warning:
        console.warn(line)
        break
      case LogLevel.Error:
        console.error(line)
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
