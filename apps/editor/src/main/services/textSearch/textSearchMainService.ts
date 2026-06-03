/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace text search backed by ripgrep.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { rgPath } from '@vscode/ripgrep'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  ILoggerService,
  URI,
  type IFileMatch,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchMatch,
  type ITextSearchProgress,
  type ITextSearchRange,
  type SearchLimitHit,
  type UriComponents,
} from '@universe-editor/platform'
import {
  ITextSearchMainService,
  type ITextSearchMainComplete,
  type ITextSearchMainProgressEvent,
  type ITextSearchMainQuery,
} from '../../../shared/ipc/textSearchService.js'

const DEFAULT_MAX_RESULTS = 10000
const DEFAULT_MAX_MATCHES_PER_FILE = 1000
const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 100
const STDERR_LIMIT = 1_000_000

const rgDiskPath = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked')

type RgBytesOrText = { bytes: string } | { text: string }

interface RgSubmatch {
  readonly match: RgBytesOrText
  readonly start: number
  readonly end: number
}

interface RgMatchData {
  readonly path: RgBytesOrText
  readonly lines: RgBytesOrText
  readonly line_number: number
  readonly submatches: RgSubmatch[]
}

interface RgSummaryData {
  readonly stats?: {
    readonly searches?: number
    readonly searches_with_match?: number
    readonly matches?: number
  }
}

interface RgMessage {
  readonly type: string
  readonly data?: unknown
}

interface RunningSearch {
  readonly process: ChildProcessWithoutNullStreams
  cancelled: boolean
  killedForLimit: boolean
}

function reviveUri(value: URI | UriComponents | string): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value) as URI
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeGlob(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function expandExcludeGlob(value: string): string[] {
  const normalized = normalizeGlob(value)
  if (!normalized) return []
  if (normalized.endsWith('/**')) return [normalized]
  return [normalized, `${normalized}/**`]
}

function buildRgArgs(query: ITextSearchMainQuery): string[] {
  const args = ['--hidden', '--no-require-git', '--no-ignore', '--no-ignore-global', '--json']
  args.push(query.matchCase ? '--case-sensitive' : '--ignore-case')
  args.push('--crlf')
  args.push('--max-filesize', String(query.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES))

  for (const include of query.includes) {
    const normalized = normalizeGlob(include)
    if (normalized) args.push('-g', normalized)
  }

  const excludes = [...query.configurationExcludes, ...query.excludes]
  for (const exclude of excludes.flatMap(expandExcludeGlob)) {
    args.push('-g', `!${exclude}`)
  }

  if (query.matchWholeWord || query.isRegex) {
    let source = query.isRegex ? query.pattern : escapeForRegex(query.pattern)
    if (query.matchWholeWord) source = `\\b(?:${source})\\b`
    source = source.replace(/\n/g, '\\r?\\n')
    args.push('--engine', 'auto', '--regexp', source)
  } else {
    args.push('--fixed-strings')
  }

  args.push('--')
  if (!query.matchWholeWord && !query.isRegex) {
    args.push(query.pattern)
  }
  args.push('.')
  return args
}

function bytesOrTextToString(value: RgBytesOrText): string {
  if ('bytes' in value) return Buffer.from(value.bytes, 'base64').toString()
  return value.text
}

function columnAtUtf8Offset(line: string, byteOffset: number): number {
  return Buffer.from(line).subarray(0, byteOffset).toString().length + 1
}

function progressOf(
  filesScanned: number,
  filesMatched: number,
  totalMatches: number,
  limitHit: SearchLimitHit | undefined,
): ITextSearchProgress {
  return limitHit !== undefined
    ? { filesScanned, filesMatched, totalMatches, limitHit }
    : { filesScanned, filesMatched, totalMatches }
}

function errorMessageFromRipgrep(stderr: string, fallback: string): string {
  const firstLine = stderr
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  return firstLine ?? fallback
}

export class TextSearchMainService extends Disposable implements ITextSearchMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _sessions = new Map<string, RunningSearch>()
  private readonly _onDidSearchProgress = this._register(
    new Emitter<ITextSearchMainProgressEvent>(),
  )
  readonly onDidSearchProgress = this._onDidSearchProgress.event

  constructor(@ILoggerService loggerService?: ILoggerServiceType) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'textSearch', name: 'Text Search' })
  }

  async search(query: ITextSearchMainQuery): Promise<ITextSearchMainComplete> {
    const root = reviveUri(query.root)
    const pattern = query.pattern.trim()
    if (pattern.length === 0) {
      return {
        results: [],
        progress: progressOf(0, 0, 0, undefined),
        durationMs: 0,
      }
    }

    const startedAt = Date.now()
    const args = buildRgArgs({ ...query, pattern })
    this._logger.info(
      `textSearch start root=${root.fsPath} includes=${query.includes.length} ` +
        `excludes=${query.excludes.length} configExcludes=${query.configurationExcludes.length}`,
    )

    const child = spawn(rgDiskPath, args, { cwd: root.fsPath })
    const running: RunningSearch = {
      process: child,
      cancelled: false,
      killedForLimit: false,
    }
    this._sessions.set(query.sessionId, running)

    const decoder = new StringDecoder('utf8')
    const results = new Map<string, IFileMatch>()
    const fileMatchCounts = new Map<string, number>()
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS
    const maxMatchesPerFile = query.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE
    let remainder = ''
    let stderr = ''
    let filesScanned = 0
    let totalMatches = 0
    let limitHit: SearchLimitHit | undefined
    let lastProgressAt = 0

    const emitProgress = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
      lastProgressAt = now
      this._onDidSearchProgress.fire({
        sessionId: query.sessionId,
        progress: progressOf(
          Math.max(filesScanned, results.size),
          results.size,
          totalMatches,
          limitHit,
        ),
      })
    }

    const stopForLimit = (): void => {
      running.killedForLimit = true
      child.kill()
    }

    const addMatch = (data: RgMatchData): void => {
      if (limitHit === 'matches') return
      const relPath = bytesOrTextToString(data.path).replace(/\\/g, '/')
      const resource = URI.file(path.join(root.fsPath, relPath)).toJSON()
      const key = URI.revive(resource)!.toString()
      const line = bytesOrTextToString(data.lines).replace(/\r?\n$/, '')
      const submatches =
        data.submatches.length > 0
          ? data.submatches
          : [{ match: { text: line.slice(0, 1) }, start: 0, end: line.length > 0 ? 1 : 0 }]
      const ranges: ITextSearchRange[] = []
      let fileCount = fileMatchCounts.get(key) ?? 0

      for (const submatch of submatches) {
        if (fileCount >= maxMatchesPerFile) {
          if (limitHit === undefined) limitHit = 'matchesPerFile'
          continue
        }
        if (totalMatches >= maxResults) {
          limitHit = 'matches'
          stopForLimit()
          break
        }
        ranges.push({
          startColumn: columnAtUtf8Offset(line, submatch.start),
          endColumn: columnAtUtf8Offset(line, submatch.end),
        })
        fileCount++
        totalMatches++
      }

      if (ranges.length === 0) return
      fileMatchCounts.set(key, fileCount)
      const match: ITextSearchMatch = {
        lineNumber: data.line_number,
        preview: line.length > 500 ? line.slice(0, 500) : line,
        ranges,
      }
      const existing = results.get(key)
      if (existing) {
        results.set(key, { ...existing, matches: [...existing.matches, match] })
      } else {
        results.set(key, { resource, matches: [match] })
      }
      emitProgress()
      if (totalMatches >= maxResults) {
        limitHit = 'matches'
        stopForLimit()
      }
    }

    const handleLine = (line: string): void => {
      if (!line) return
      let message: RgMessage
      try {
        message = JSON.parse(line) as RgMessage
      } catch {
        this._logger.warn(`textSearch malformed rg line length=${line.length}`)
        return
      }
      if (message.type === 'match') {
        addMatch(message.data as RgMatchData)
      } else if (message.type === 'summary') {
        filesScanned = (message.data as RgSummaryData | undefined)?.stats?.searches ?? filesScanned
      }
    }

    const handleData = (chunk: string): void => {
      const data = remainder + chunk
      const lines = data.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      for (const line of lines) handleLine(line.trim())
    }

    return await new Promise<ITextSearchMainComplete>((resolve, reject) => {
      child.stdout.on('data', (data: Buffer) => handleData(decoder.write(data)))
      child.stderr.on('data', (data: Buffer) => {
        const next = data.toString()
        if (stderr.length + next.length < STDERR_LIMIT) stderr += next
      })
      child.on('error', (err) => {
        this._sessions.delete(query.sessionId)
        reject(err)
      })
      child.on('close', (code) => {
        handleData(decoder.end())
        if (remainder.trim().length > 0) {
          handleLine(remainder.trim())
          remainder = ''
        }
        this._sessions.delete(query.sessionId)
        const durationMs = Date.now() - startedAt
        const progress = progressOf(
          Math.max(filesScanned, results.size),
          results.size,
          totalMatches,
          limitHit,
        )
        emitProgress(true)

        this._logger.info(
          `textSearch finished files=${progress.filesScanned} matched=${progress.filesMatched} ` +
            `matches=${progress.totalMatches} limit=${progress.limitHit ?? 'none'} ` +
            `cancelled=${running.cancelled} ms=${durationMs}`,
        )

        if (!running.cancelled && !running.killedForLimit && code !== 0 && code !== 1) {
          reject(new Error(errorMessageFromRipgrep(stderr, `ripgrep exited with code ${code}`)))
          return
        }

        resolve({
          results: [...results.values()],
          progress,
          durationMs,
        })
      })
    })
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) return
    session.cancelled = true
    session.process.kill()
  }

  override dispose(): void {
    for (const session of this._sessions.values()) {
      session.cancelled = true
      session.process.kill()
    }
    this._sessions.clear()
    super.dispose()
  }
}
