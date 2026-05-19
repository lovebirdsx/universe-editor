/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side ILoggerService: routes log entries via IPC to the main process.
 *  Keeps a ConsoleLogger mirror in dev mode so DevTools shows logs too.
 *--------------------------------------------------------------------------------------------*/

import {
  AbstractLogger,
  ConsoleLogger,
  ILoggerService,
  LogLevel,
  MultiplexLogger,
  type ILogger,
  type ILogChannel,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'
import type { ILogChannelService } from '../../../shared/ipc/services.js'

class IpcLogger extends AbstractLogger {
  constructor(
    private readonly _proxy: ILogChannelService,
    private readonly _windowId: number,
    private readonly _channel: string,
    level: LogLevel,
  ) {
    super(level)
  }

  protected _log(level: LogLevel, message: string): void {
    void this._proxy.append(this._windowId, this._channel, level, message)
  }
}

/**
 * Renderer implementation of ILoggerService.
 * Each `createLogger` call returns a logger that sends entries to the main process
 * via ILogChannelService IPC, plus a ConsoleLogger in dev builds.
 */
export class RendererLoggerService implements ILoggerServiceType {
  declare readonly _serviceBrand: undefined

  private _level: LogLevel = LogLevel.Info
  private readonly _loggers = new Map<string, ILogger>()

  constructor(
    private readonly _logChannelProxy: ILogChannelService,
    private readonly _windowId: number,
  ) {}

  createLogger(channel: ILogChannel): ILogger {
    let logger = this._loggers.get(channel.id)
    if (!logger) {
      const ipcLogger = new IpcLogger(
        this._logChannelProxy,
        this._windowId,
        channel.id,
        this._level,
      )
      // In dev, also echo to console for quick iteration
      if (import.meta.env.DEV) {
        logger = new MultiplexLogger([ipcLogger, new ConsoleLogger(this._level)], this._level)
      } else {
        logger = ipcLogger
      }
      this._loggers.set(channel.id, logger)
    }
    return logger
  }

  setLevel(level: LogLevel): void {
    this._level = level
    for (const logger of this._loggers.values()) {
      logger.setLevel(level)
    }
  }

  getLevel(): LogLevel {
    return this._level
  }
}

// Re-export ILoggerService decorator so callers can do:
//   import { ILoggerService } from '@universe-editor/platform'
export { ILoggerService }
