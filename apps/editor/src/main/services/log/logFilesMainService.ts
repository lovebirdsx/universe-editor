/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only log file browser for renderer actions.
 *--------------------------------------------------------------------------------------------*/

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { LogLevel } from '@universe-editor/platform'
import type { ILogFilesService, LogFileDescriptor } from '../../../shared/ipc/services.js'
import type { LogMainService } from './logMainService.js'

const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
const LOG_FILE_RE = /^[A-Za-z0-9._-]+\.log$/

const LOG_LABELS: Record<string, string> = {
  main: 'Main',
  renderer: 'Renderer',
  window: 'Window',
  workspace: 'Workspace',
  fileSystem: 'File System',
  fileWatcher: 'File Watcher',
  host: 'Host',
  command: 'Command',
  editor: 'Editor',
  editorGroups: 'Editor Groups',
  monaco: 'Monaco',
  action: 'Action',
}

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

function labelFromChannelId(channelId: string): string {
  const rendererMatch = /^renderer-(.+)$/.exec(channelId)
  if (rendererMatch?.[1]) return `Renderer ${rendererMatch[1]}`

  const direct = LOG_LABELS[channelId]
  if (direct) return direct

  return channelId
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class LogFilesMainService implements ILogFilesService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _logService: LogMainService) {}

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
        result.push({
          id: `${date}/${file.name}`,
          name: labelFromChannelId(channelId),
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
      return `[Log truncated to last ${formatLimit(limit)}]\n${buffer.toString('utf8')}`
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

  async setLogLevel(level: LogLevel): Promise<void> {
    this._logService.setLevel(level)
  }

  async getLogLevel(): Promise<LogLevel> {
    return this._logService.getLevel()
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
