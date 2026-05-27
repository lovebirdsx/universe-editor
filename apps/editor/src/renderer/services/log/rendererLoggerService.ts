/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side ILoggerService: routes log entries via IPC to the main process.
 *  Keeps a ConsoleLogger mirror in dev mode so DevTools shows logs too.
 *--------------------------------------------------------------------------------------------*/

import {
  AbstractLogger,
  ConsoleLogger,
  Disposable,
  ILoggerService,
  LogLevel,
  MultiplexLogger,
  getOriginalConsole,
  type ILogger,
  type ILogChannel,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'
import type { ILogChannelService, LogEntry } from '../../../shared/ipc/services.js'

interface IpcBatcher {
  enqueue(entry: LogEntry): void
  flush(): Promise<void>
}

class WindowLogBatcher implements IpcBatcher {
  private _pending: LogEntry[] = []
  private _flushScheduled = false
  private _inFlight: Promise<void> | null = null

  constructor(
    private readonly _proxy: ILogChannelService,
    private readonly _windowId: number,
  ) {}

  enqueue(entry: LogEntry): void {
    this._pending.push(entry)
    if (!this._flushScheduled) {
      this._flushScheduled = true
      queueMicrotask(() => {
        this._flushScheduled = false
        void this._send()
      })
    }
  }

  async flush(): Promise<void> {
    // Drain any pending entries (synchronous send) then await in-flight work.
    if (this._pending.length > 0) {
      await this._send()
    } else if (this._inFlight) {
      await this._inFlight
    }
  }

  private async _send(): Promise<void> {
    if (this._pending.length === 0) return
    const batch = this._pending
    this._pending = []
    const work = this._proxy.appendBatch(this._windowId, batch).catch((err) => {
      // Critical: bypass the console interceptor so an IPC failure here cannot
      // recurse through the interceptor into this same batcher.
      getOriginalConsole().error('[RendererLogger] failed to forward log batch:', err)
    })
    this._inFlight = work
    try {
      await work
    } finally {
      if (this._inFlight === work) this._inFlight = null
    }
  }
}

class IpcLogger extends AbstractLogger {
  constructor(
    private readonly _batcher: IpcBatcher,
    private readonly _channel: string,
    level: LogLevel,
  ) {
    super(level)
  }

  protected _log(level: LogLevel, message: string): void {
    this._batcher.enqueue({
      channel: this._channel,
      level,
      message,
      timestamp: Date.now(),
    })
  }

  override flush(): void {
    void this._batcher.flush()
  }
}

/**
 * Renderer implementation of ILoggerService.
 * Each `createLogger` call returns a logger that sends entries to the main process
 * via ILogChannelService IPC, plus a ConsoleLogger in dev builds.
 */
export class RendererLoggerService extends Disposable implements ILoggerServiceType {
  declare readonly _serviceBrand: undefined

  private _level: LogLevel = LogLevel.Info
  private readonly _loggers = new Map<string, ILogger>()
  private readonly _batcher: WindowLogBatcher

  constructor(logChannelProxy: ILogChannelService, windowId: number) {
    super()
    this._batcher = new WindowLogBatcher(logChannelProxy, windowId)
  }

  createLogger(channel: ILogChannel): ILogger {
    let logger = this._loggers.get(channel.id)
    if (!logger) {
      const ipcLogger = this._register(new IpcLogger(this._batcher, channel.id, this._level))
      // In dev, also echo to console for quick iteration
      if (import.meta.env.DEV) {
        const consoleLogger = this._register(new ConsoleLogger(this._level))
        logger = this._register(new MultiplexLogger([ipcLogger, consoleLogger], this._level))
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

  /**
   * Flush every buffered log entry across all loggers managed by this service.
   * Called from a `beforeunload` hook so renderer exits don't drop log lines.
   */
  async flush(): Promise<void> {
    for (const logger of this._loggers.values()) {
      logger.flush()
    }
    await this._batcher.flush()
  }
}

// Re-export ILoggerService decorator so callers can do:
//   import { ILoggerService } from '@universe-editor/platform'
export { ILoggerService }
