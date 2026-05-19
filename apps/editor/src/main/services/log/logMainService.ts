/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process ILoggerService: writes per-channel log files under
 *  <userData>/logs/<YYYY-MM-DD>/{channel}.log, with daily rotation and a
 *  10 MB per-file size cap.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  AbstractLogger,
  LogLevel,
  type ILogger,
  type ILoggerService,
  type ILogChannel,
} from '@universe-editor/platform'
import type { ILogChannelService } from '../../../shared/ipc/services.js'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const FLUSH_DEBOUNCE_MS = 150

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warn',
  [LogLevel.Error]: 'error',
}

function todayDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

class FileLogger extends AbstractLogger {
  private _logPath: string
  private _currentDate: string
  private readonly _logDir: string
  private readonly _channelId: string
  private _writeQueue: string[] = []
  private _pendingFlush: ReturnType<typeof setTimeout> | null = null
  private _estimatedSize = 0

  constructor(logDir: string, channelId: string, level: LogLevel) {
    super(level)
    this._logDir = logDir
    this._channelId = channelId
    this._currentDate = todayDateString()
    this._logPath = join(logDir, this._currentDate, `${channelId}.log`)
  }

  protected _log(level: LogLevel, message: string): void {
    const now = todayDateString()
    if (now !== this._currentDate) {
      this._currentDate = now
      this._logPath = join(this._logDir, this._currentDate, `${this._channelId}.log`)
      this._estimatedSize = 0
    }

    const ts = new Date().toISOString()
    const label = LOG_LEVEL_LABELS[level] ?? 'log'
    const line = `[${ts}] [${label}] ${message}\n`
    this._writeQueue.push(line)
    this._estimatedSize += line.length
    this._scheduleFlush()
  }

  private _scheduleFlush(): void {
    if (this._pendingFlush !== null) return
    this._pendingFlush = setTimeout(() => {
      this._pendingFlush = null
      void this._doFlush()
    }, FLUSH_DEBOUNCE_MS)
  }

  override flush(): void {
    if (this._pendingFlush !== null) {
      clearTimeout(this._pendingFlush)
      this._pendingFlush = null
    }
    void this._doFlush()
  }

  private async _doFlush(): Promise<void> {
    if (this._writeQueue.length === 0) return
    const lines = this._writeQueue.splice(0)
    const content = lines.join('')
    try {
      await this._ensureLogDir()
      // Rotate if the file is too large
      if (this._estimatedSize > MAX_FILE_SIZE) {
        await this._rotate()
      }
      await fs.appendFile(this._logPath, content, 'utf8')
    } catch (err) {
      console.error('[LogMainService] Failed to write log:', err)
    }
  }

  private async _ensureLogDir(): Promise<void> {
    const dir = join(this._logDir, this._currentDate)
    await fs.mkdir(dir, { recursive: true })
  }

  private async _rotate(): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const rotated = this._logPath.replace('.log', `.${ts}.log`)
    try {
      await fs.rename(this._logPath, rotated)
    } catch {
      // File may not exist yet; ignore
    }
    this._estimatedSize = 0
  }

  override dispose(): void {
    this.flush()
    super.dispose()
  }
}

/**
 * Main-process implementation of ILoggerService. Each call to `createLogger`
 * returns (or retrieves) a FileLogger writing to `<userData>/logs/<date>/<channelId>.log`.
 */
export class LogMainService implements ILoggerService {
  declare readonly _serviceBrand: undefined

  private readonly _logDir: string
  private _level: LogLevel = LogLevel.Info
  private readonly _loggers = new Map<string, FileLogger>()

  constructor() {
    this._logDir = join(app.getPath('userData'), 'logs')
  }

  createLogger(channel: ILogChannel): ILogger {
    let logger = this._loggers.get(channel.id)
    if (!logger) {
      logger = new FileLogger(this._logDir, channel.id, this._level)
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

  dispose(): void {
    for (const logger of this._loggers.values()) {
      logger.dispose()
    }
    this._loggers.clear()
  }
}

/**
 * IPC receiver: renderer windows send log entries here via ProxyChannel.
 * Routes each entry to the appropriate FileLogger in LogMainService.
 */
export class MainLogChannelService implements ILogChannelService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _logService: LogMainService) {}

  async append(windowId: number, channel: string, level: LogLevel, message: string): Promise<void> {
    const logger = this._logService.createLogger({
      id: `renderer-${windowId}`,
      name: `Renderer ${windowId}`,
    })
    switch (level) {
      case LogLevel.Trace:
        logger.trace(`[${channel}] ${message}`)
        break
      case LogLevel.Debug:
        logger.debug(`[${channel}] ${message}`)
        break
      case LogLevel.Info:
        logger.info(`[${channel}] ${message}`)
        break
      case LogLevel.Warning:
        logger.warn(`[${channel}] ${message}`)
        break
      case LogLevel.Error:
        logger.error(`[${channel}] ${message}`)
        break
    }
  }
}
