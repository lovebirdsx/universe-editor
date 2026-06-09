/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only log file browser for renderer actions. Scoped to a single window:
 *  it surfaces the shared main-process channels (session root) plus this
 *  window's private renderer channels (window-<id>/), and filters the live
 *  append stream the same way, so one window never sees another window's logs.
 *  Historical sessions remain on disk under <userData>/logs/<sessionId>/.
 *--------------------------------------------------------------------------------------------*/

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Event, LogLevel } from '@universe-editor/platform'
import type {
  ILogFilesService,
  LogAppendEvent,
  LogFileDescriptor,
} from '../../../shared/ipc/services.js'
import { ILogMainService, SESSION_DIR_RE, type LogMainService } from './logMainService.js'
import { humanizeChannelId } from '../../../shared/log/logLabels.js'

const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024
const LOG_FILE_RE = /^[A-Za-z0-9._-]+\.log$/
const WINDOW_DIR_RE = /^window-(\d+)$/

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_MAX_BYTES
  return Math.min(Math.floor(maxBytes), MAX_READ_BYTES)
}

function formatLimit(limit: number): string {
  if (limit === DEFAULT_MAX_BYTES) return '1 MB'
  if (limit % (1024 * 1024) === 0) return `${limit / (1024 * 1024)} MB`
  if (limit % 1024 === 0) return `${limit / 1024} KB`
  return `${limit} bytes`
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class LogFilesMainService implements ILogFilesService {
  declare readonly _serviceBrand: undefined

  readonly onDidAppendEntry: Event<LogAppendEvent>

  constructor(
    @ILogMainService private readonly _logService: LogMainService,
    private readonly _windowId: number,
  ) {
    // Only the shared main-process entries (no windowId) and this window's own
    // renderer entries reach the panel; other windows' entries are dropped.
    this.onDidAppendEntry = Event.filter(
      _logService.onDidAppendEntry,
      (e) => e.windowId === undefined || e.windowId === this._windowId,
    )
  }

  async listLogFiles(): Promise<LogFileDescriptor[]> {
    const sessionId = this._logService.getSessionId()
    const sessionStartedAt = this._logService.getSessionStartedAt()
    const sessionDir = this._logService.getSessionDir()
    const windowDir = this._logService.getWindowDir(this._windowId)

    const shared = await this._readDir(sessionDir, sessionId, sessionStartedAt, undefined)
    const priv = await this._readDir(
      windowDir,
      `${sessionId}/window-${this._windowId}`,
      sessionStartedAt,
      this._windowId,
    )

    // A channelId present in both directories (e.g. `console`, written by both
    // main and this window's renderer) collides on `name`, which the renderer's
    // OutputService keys by. Disambiguate the shared one with a "(Main)" suffix
    // so both rows survive in the dropdown.
    const privChannelIds = new Set(priv.map((d) => d.channelId))
    const result = [
      ...shared.map((d) =>
        privChannelIds.has(d.channelId) ? { ...d, name: `${d.name} (Main)` } : d,
      ),
      ...priv,
    ]

    return result.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.name.localeCompare(b.name)
    })
  }

  private async _readDir(
    dir: string,
    idPrefix: string,
    sessionStartedAt: string,
    windowId: number | undefined,
  ): Promise<LogFileDescriptor[]> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    const result: LogFileDescriptor[] = []
    for (const file of entries) {
      if (!file.isFile() || !LOG_FILE_RE.test(file.name)) continue
      const stat = await fs.stat(join(dir, file.name))
      const channelId = basename(file.name, '.log')
      const registered = this._logService.getChannel(channelId)
      result.push({
        id: `${idPrefix}/${file.name}`,
        name: registered?.name ?? humanizeChannelId(channelId),
        channelId,
        sessionStartedAt,
        size: stat.size,
        modifiedTime: stat.mtimeMs,
        ...(windowId === undefined ? {} : { windowId }),
      })
    }
    return result
  }

  async readLogFile(id: string, maxBytes?: number): Promise<string> {
    const target = this._resolveId(id)
    const stat = await fs.stat(target)
    if (!stat.isFile() || extname(target) !== '.log') {
      throw new Error(`Invalid log file id: ${id}`)
    }

    const limit = normalizeMaxBytes(maxBytes)
    if (stat.size <= limit) {
      return fs.readFile(target, 'utf8')
    }

    const handle = await fs.open(target, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      await handle.read(buffer, 0, limit, stat.size - limit)
      const text = buffer.toString('utf8')
      // The tail offset may land mid-character or mid-line; drop the first
      // partial line so the output never starts with a broken code point.
      const firstNewline = text.indexOf('\n')
      const safe = firstNewline === -1 ? text : text.slice(firstNewline + 1)
      return `[Log truncated to last ${formatLimit(limit)}]\n${safe}`
    } finally {
      await handle.close()
    }
  }

  async openLogsFolder(): Promise<void> {
    const root = this._root()
    await fs.mkdir(root, { recursive: true })
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
  }

  async resolveLogPath(id: string): Promise<string> {
    return this._resolveId(id)
  }

  async setLogLevel(level: LogLevel): Promise<void> {
    this._logService.setLevel(level)
  }

  async getLogLevel(): Promise<LogLevel> {
    return this._logService.getLevel()
  }

  async setTimestampFormat(format: string): Promise<void> {
    this._logService.setTimestampFormat(format)
  }

  async getTimestampFormat(): Promise<string> {
    return this._logService.getTimestampFormat()
  }

  private _root(): string {
    return resolve(this._logService.getLogRoot())
  }

  /**
   * Resolve a descriptor id to an absolute path under the log root. Accepts
   * `<session>/<file>.log` (shared) and `<session>/window-<id>/<file>.log`
   * (window-private), validating every segment and guarding against traversal.
   */
  private _resolveId(id: string): string {
    const parts = id.split('/')
    const file = parts[parts.length - 1]
    if (file === undefined || !LOG_FILE_RE.test(file)) {
      throw new Error(`Invalid log file id: ${id}`)
    }

    const sessionId = parts[0]
    if (sessionId === undefined || !SESSION_DIR_RE.test(sessionId)) {
      throw new Error(`Invalid log file id: ${id}`)
    }

    let target: string
    if (parts.length === 2) {
      target = resolve(this._root(), sessionId, file)
    } else if (parts.length === 3 && parts[1] !== undefined && WINDOW_DIR_RE.test(parts[1])) {
      target = resolve(this._root(), sessionId, parts[1], file)
    } else {
      throw new Error(`Invalid log file id: ${id}`)
    }

    if (!isInside(this._root(), target)) {
      throw new Error(`Invalid log file id: ${id}`)
    }
    return target
  }
}
