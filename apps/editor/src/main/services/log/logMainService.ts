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
  Emitter,
  Event,
  LogLevel,
  formatLogTimestamp,
  LOG_TIMESTAMP_FORMAT_DEFAULT,
  type ILogger,
  type ILoggerService,
  type ILogChannel,
} from '@universe-editor/platform'

export interface LogAppendEvent {
  readonly channelId: string
  readonly chunk: string
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const FLUSH_DEBOUNCE_MS = 150
const MAX_BUFFER_LINES = 10000
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/

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
  private readonly _onChunk: (channelId: string, chunk: string) => void
  private _writeQueue: string[] = []
  private _pendingFlush: ReturnType<typeof setTimeout> | null = null
  private _estimatedSize = 0
  private _timestampFormat: string = LOG_TIMESTAMP_FORMAT_DEFAULT

  constructor(
    logDir: string,
    channelId: string,
    level: LogLevel,
    onChunk: (channelId: string, chunk: string) => void,
  ) {
    super(level)
    this._logDir = logDir
    this._channelId = channelId
    this._onChunk = onChunk
    this._currentDate = todayDateString()
    this._logPath = join(logDir, this._currentDate, `${channelId}.log`)
  }

  setTimestampFormat(format: string): void {
    this._timestampFormat = format
  }

  protected _log(level: LogLevel, message: string): void {
    this._enqueue(level, message, Date.now())
  }

  /** Variant used by IPC arrivals: log with the timestamp recorded by the caller. */
  logWithTimestamp(level: LogLevel, message: string, timestampMs: number): void {
    if (level === LogLevel.Off || level < this.level) return
    this._enqueue(level, message, timestampMs)
  }

  private _enqueue(level: LogLevel, message: string, timestampMs: number): void {
    const now = todayDateString()
    if (now !== this._currentDate) {
      this._currentDate = now
      this._logPath = join(this._logDir, this._currentDate, `${this._channelId}.log`)
      this._estimatedSize = 0
    }

    const ts = formatLogTimestamp(new Date(timestampMs), this._timestampFormat)
    const label = LOG_LEVEL_LABELS[level] ?? 'log'
    const line = `[${ts}] [${label}] ${message}\n`
    this._writeQueue.push(line)
    this._estimatedSize += line.length
    if (this._writeQueue.length > MAX_BUFFER_LINES) {
      const dropped = this._writeQueue.length - MAX_BUFFER_LINES + 1
      this._writeQueue.splice(0, dropped)
      const warnTs = formatLogTimestamp(new Date(), this._timestampFormat)
      this._writeQueue.push(`[${warnTs}] [warn] dropped ${dropped} buffered log entries\n`)
    }
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
      if (this._estimatedSize > MAX_FILE_SIZE) {
        await this._rotate()
      }
      await fs.appendFile(this._logPath, content, 'utf8')
      this._onChunk(this._channelId, content)
    } catch (err) {
      console.error('[LogMainService] Failed to write log:', err)
    }
  }

  private async _ensureLogDir(): Promise<void> {
    const dir = join(this._logDir, this._currentDate)
    await fs.mkdir(dir, { recursive: true })
  }

  private async _rotate(): Promise<void> {
    const rotatedDir = join(this._logDir, this._currentDate, 'rotated')
    await fs.mkdir(rotatedDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const rotated = join(rotatedDir, `${this._channelId}.${ts}.log`)
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
  private _timestampFormat: string = LOG_TIMESTAMP_FORMAT_DEFAULT
  private readonly _loggers = new Map<string, FileLogger>()
  private readonly _channels = new Map<string, ILogChannel>()
  private readonly _onDidAppendEntry = new Emitter<LogAppendEvent>()
  readonly onDidAppendEntry: Event<LogAppendEvent> = this._onDidAppendEntry.event

  constructor() {
    this._logDir = join(app.getPath('userData'), 'logs')
  }

  getLogRoot(): string {
    return this._logDir
  }

  getChannel(id: string): ILogChannel | undefined {
    return this._channels.get(id)
  }

  getChannels(): readonly ILogChannel[] {
    return Array.from(this._channels.values())
  }

  createLogger(channel: ILogChannel): ILogger {
    this._channels.set(channel.id, channel)
    let logger = this._loggers.get(channel.id)
    if (!logger) {
      logger = new FileLogger(this._logDir, channel.id, this._level, this._fireAppend)
      logger.setTimestampFormat(this._timestampFormat)
      this._loggers.set(channel.id, logger)
    }
    return logger
  }

  /**
   * Append a pre-formatted message to a channel using a caller-supplied
   * timestamp. Used by MainLogChannelService when forwarding renderer entries
   * so the recorded time reflects when the renderer fired, not when main
   * received the IPC.
   */
  appendToChannel(
    channel: ILogChannel,
    level: LogLevel,
    message: string,
    timestampMs: number,
  ): void {
    this._channels.set(channel.id, channel)
    let logger = this._loggers.get(channel.id)
    if (!logger) {
      logger = new FileLogger(this._logDir, channel.id, this._level, this._fireAppend)
      logger.setTimestampFormat(this._timestampFormat)
      this._loggers.set(channel.id, logger)
    }
    logger.logWithTimestamp(level, message, timestampMs)
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

  setTimestampFormat(format: string): void {
    this._timestampFormat = format
    for (const logger of this._loggers.values()) {
      logger.setTimestampFormat(format)
    }
  }

  getTimestampFormat(): string {
    return this._timestampFormat
  }

  async cleanupOldLogs(retainDays = 30): Promise<void> {
    let dirs
    try {
      dirs = await fs.readdir(this._logDir, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000
    await Promise.all(
      dirs.map(async (entry) => {
        if (!entry.isDirectory() || !DATE_DIR_RE.test(entry.name)) return
        const t = Date.parse(`${entry.name}T00:00:00Z`)
        if (!Number.isFinite(t) || t >= cutoff) return
        try {
          await fs.rm(join(this._logDir, entry.name), { recursive: true, force: true })
        } catch {
          // best-effort cleanup; do not fail startup
        }
      }),
    )
  }

  dispose(): void {
    for (const logger of this._loggers.values()) {
      logger.dispose()
    }
    this._loggers.clear()
    this._onDidAppendEntry.dispose()
  }

  private readonly _fireAppend = (channelId: string, chunk: string): void => {
    this._onDidAppendEntry.fire({ channelId, chunk })
  }
}
