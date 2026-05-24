/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process ILoggerService: writes per-channel log files under
 *  <userData>/logs/<sessionId>/{channel}.log. Each process launch picks a fresh
 *  sessionId (YYYYMMDDTHHmmss) so the Output panel only ever shows logs from
 *  this run; historical sessions are retained on disk (capped at the latest N)
 *  for post-mortem inspection.
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
export const SESSION_DIR_RE = /^\d{8}T\d{6}$/

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warn',
  [LogLevel.Error]: 'error',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatSessionId(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function parseSessionId(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const ms = t.getTime()
  return Number.isFinite(ms) ? ms : null
}

function formatSessionStartedAt(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

class FileLogger extends AbstractLogger {
  private readonly _logPath: string
  private readonly _sessionDir: string
  private readonly _channelId: string
  private readonly _onChunk: (channelId: string, chunk: string) => void
  private _writeQueue: string[] = []
  private _pendingFlush: ReturnType<typeof setTimeout> | null = null
  private _estimatedSize = 0
  private _timestampFormat: string = LOG_TIMESTAMP_FORMAT_DEFAULT

  constructor(
    sessionDir: string,
    channelId: string,
    level: LogLevel,
    onChunk: (channelId: string, chunk: string) => void,
  ) {
    super(level)
    this._sessionDir = sessionDir
    this._channelId = channelId
    this._onChunk = onChunk
    this._logPath = join(sessionDir, `${channelId}.log`)
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
      await this._ensureSessionDir()
      if (this._estimatedSize > MAX_FILE_SIZE) {
        await this._rotate()
      }
      await fs.appendFile(this._logPath, content, 'utf8')
      this._onChunk(this._channelId, content)
    } catch (err) {
      console.error('[LogMainService] Failed to write log:', err)
    }
  }

  private async _ensureSessionDir(): Promise<void> {
    await fs.mkdir(this._sessionDir, { recursive: true })
  }

  private async _rotate(): Promise<void> {
    const rotatedDir = join(this._sessionDir, 'rotated')
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
 * returns (or retrieves) a FileLogger writing to
 * `<userData>/logs/<sessionId>/<channelId>.log`. The sessionId is chosen once
 * per process launch (mirroring VS Code's behavior) so the Output panel never
 * surfaces logs from a previous run.
 */
export class LogMainService implements ILoggerService {
  declare readonly _serviceBrand: undefined

  private readonly _logDir: string
  private readonly _sessionId: string
  private readonly _sessionDir: string
  private readonly _sessionStartedAt: string
  private _level: LogLevel = LogLevel.Info
  private _timestampFormat: string = LOG_TIMESTAMP_FORMAT_DEFAULT
  private readonly _loggers = new Map<string, FileLogger>()
  private readonly _channels = new Map<string, ILogChannel>()
  private readonly _onDidAppendEntry = new Emitter<LogAppendEvent>()
  readonly onDidAppendEntry: Event<LogAppendEvent> = this._onDidAppendEntry.event

  constructor() {
    this._logDir = join(app.getPath('userData'), 'logs')
    const now = new Date()
    this._sessionId = formatSessionId(now)
    this._sessionDir = join(this._logDir, this._sessionId)
    this._sessionStartedAt = formatSessionStartedAt(now)
  }

  getLogRoot(): string {
    return this._logDir
  }

  getSessionId(): string {
    return this._sessionId
  }

  getSessionDir(): string {
    return this._sessionDir
  }

  getSessionStartedAt(): string {
    return this._sessionStartedAt
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
      logger = new FileLogger(this._sessionDir, channel.id, this._level, this._fireAppend)
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
      logger = new FileLogger(this._sessionDir, channel.id, this._level, this._fireAppend)
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

  /**
   * Keep at most `retainSessions` past session directories (the current one is
   * always kept). Pre-existing directories that don't match the session naming
   * (e.g. legacy YYYY-MM-DD folders from earlier builds) are removed wholesale.
   */
  async cleanupOldLogs(retainSessions = 20): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(this._logDir, { withFileTypes: true })
    } catch {
      return
    }

    const sessions: { name: string; time: number }[] = []
    const legacy: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const t = SESSION_DIR_RE.test(entry.name) ? parseSessionId(entry.name) : null
      if (t !== null) {
        sessions.push({ name: entry.name, time: t })
      } else {
        legacy.push(entry.name)
      }
    }

    sessions.sort((a, b) => b.time - a.time)
    const toRemove = sessions
      .slice(retainSessions)
      .filter((s) => s.name !== this._sessionId)
      .map((s) => s.name)

    await Promise.all(
      [...toRemove, ...legacy].map(async (name) => {
        try {
          await fs.rm(join(this._logDir, name), { recursive: true, force: true })
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
