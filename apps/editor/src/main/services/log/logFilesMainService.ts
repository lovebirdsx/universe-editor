/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only log file browser for renderer actions.
 *--------------------------------------------------------------------------------------------*/

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { LogLevel, type Event } from '@universe-editor/platform'
import type {
  ILogFilesService,
  LogAppendEvent,
  LogFileDescriptor,
} from '../../../shared/ipc/services.js'
import type { LogMainService } from './logMainService.js'
import { humanizeChannelId } from './logLabels.js'

const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
const LOG_FILE_RE = /^[A-Za-z0-9._-]+\.log$/

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

  constructor(private readonly _logService: LogMainService) {
    this.onDidAppendEntry = _logService.onDidAppendEntry
  }

  async listLogFiles(): Promise<LogFileDescriptor[]> {
    const root = this._root()
    let dirs
    try {
      dirs = await fs.readdir(root, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    const result: LogFileDescriptor[] = []
    for (const dir of dirs) {
      if (!dir.isDirectory() || !DATE_DIR_RE.test(dir.name)) continue
      const date = dir.name
      const dateDir = join(root, date)
      const files = await fs.readdir(dateDir, { withFileTypes: true })
      for (const file of files) {
        if (!file.isFile() || !LOG_FILE_RE.test(file.name)) continue
        const fullPath = this._resolve(date, file.name)
        const stat = await fs.stat(fullPath)
        const channelId = basename(file.name, '.log')
        const registered = this._logService.getChannel(channelId)
        result.push({
          id: `${date}/${file.name}`,
          name: registered?.name ?? humanizeChannelId(channelId),
          channelId,
          date,
          size: stat.size,
          modifiedTime: stat.mtimeMs,
        })
      }
    }

    return result.sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date)
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.name.localeCompare(b.name)
    })
  }

  async readLogFile(id: string, maxBytes?: number): Promise<string> {
    const { date, fileName } = this._parseId(id)
    const target = this._resolve(date, fileName)
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
    const { date, fileName } = this._parseId(id)
    return this._resolve(date, fileName)
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

  private _parseId(id: string): { date: string; fileName: string } {
    const parts = id.split('/')
    const date = parts[0]
    const fileName = parts[1]
    if (parts.length !== 2 || !date || !fileName) {
      throw new Error(`Invalid log file id: ${id}`)
    }
    if (!DATE_DIR_RE.test(date) || !LOG_FILE_RE.test(fileName)) {
      throw new Error(`Invalid log file id: ${id}`)
    }
    return { date, fileName }
  }

  private _resolve(date: string, fileName: string): string {
    const root = this._root()
    const target = resolve(root, date, fileName)
    if (!isInside(root, target)) {
      throw new Error(`Invalid log file id: ${date}/${fileName}`)
    }
    return target
  }
}
