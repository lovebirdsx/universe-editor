/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace text search backed by ripgrep.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { rgPath } from '@vscode/ripgrep'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
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
import { ManagedChildProcess } from '../process/managedChildProcess.js'
import {
  ITextSearchMainService,
  type ITextSearchMainComplete,
  type ITextSearchMainProgressEvent,
  type ITextSearchMainQuery,
  type ITextSearchMainResultsEvent,
} from '../../../shared/ipc/textSearchService.js'

const DEFAULT_MAX_RESULTS = 10000
const DEFAULT_MAX_MATCHES_PER_FILE = 1000
const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 100
// Incremental result flush cadence, mirroring VSCode's batching intent: the
// first files stream out immediately (no wait) so the user sees hits at once;
// afterwards changed files are coalesced on this interval to keep IPC and
// re-render frequency bounded on very large result sets.
const RESULTS_FLUSH_INTERVAL_MS = 100
const RESULTS_FLUSH_AFTER_COUNT = 50
const STDERR_LIMIT = 1_000_000

export function resolveRipgrepDiskPath(ripgrepPath: string = rgPath): string {
  return ripgrepPath.replace(/\.asar([\\/])/g, '.asar.unpacked$1')
}

const rgDiskPath = resolveRipgrepDiskPath()

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
  readonly process: ManagedChildProcess
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
  args.push('--follow')
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

// Mirrors VSCode's ripgrepTextSearchEngine: ripgrep exits with a non-zero code
// (typically 2) when it hits *any* problem, including non-fatal ones such as a
// single unreadable path or a broken symlink (`.node_modules\... (os error 2)`),
// while still searching the rest of the tree and producing valid results.
// Only genuinely fatal diagnostics — a bad regex, a bad glob, an unknown
// encoding, or a disallowed literal — should surface as a search failure.
// Everything else returns undefined so the results are kept and no error is
// reported to the user.
export function rgErrorMsgForDisplay(msg: string): string | undefined {
  const lines = msg.split('\n').filter((line) => line.trim().length > 0)
  const firstLine = lines[0]?.trim() ?? ''

  if (lines.some((line) => line.trim().startsWith('regex parse error'))) {
    return errorMessageFromRipgrep(msg, 'regex parse error')
  }

  const encodingMatch = firstLine.match(/grep config error: unknown encoding: (.*)/)
  if (encodingMatch) return `Unknown encoding: ${encodingMatch[1]}`

  if (firstLine.startsWith('error parsing glob') || firstLine.startsWith('the literal')) {
    return firstLine.charAt(0).toUpperCase() + firstLine.slice(1)
  }

  return undefined
}

export class TextSearchMainService extends Disposable implements ITextSearchMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _sessions = new Map<string, RunningSearch>()
  private readonly _onDidSearchProgress = this._register(
    new Emitter<ITextSearchMainProgressEvent>(),
  )
  readonly onDidSearchProgress = this._onDidSearchProgress.event
  private readonly _onDidSearchResults = this._register(new Emitter<ITextSearchMainResultsEvent>())
  readonly onDidSearchResults = this._onDidSearchResults.event

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

    const child = new ManagedChildProcess(spawn(rgDiskPath, args, { cwd: root.fsPath }), {
      logger: this._logger,
      label: query.sessionId,
    })
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
    // Keys of files whose match set changed since the last incremental flush.
    const dirtyKeys = new Set<string>()
    let flushedCount = 0
    let lastFlushAt = 0

    const flushResults = (force = false): void => {
      if (dirtyKeys.size === 0) return
      const now = Date.now()
      // Stream the first files out immediately; coalesce the rest on an interval.
      if (!force && flushedCount >= RESULTS_FLUSH_AFTER_COUNT) {
        if (now - lastFlushAt < RESULTS_FLUSH_INTERVAL_MS) return
      }
      lastFlushAt = now
      const batch: IFileMatch[] = []
      for (const key of dirtyKeys) {
        const fm = results.get(key)
        if (fm) batch.push(fm)
      }
      dirtyKeys.clear()
      flushedCount += batch.length
      if (batch.length > 0) {
        this._onDidSearchResults.fire({ sessionId: query.sessionId, results: batch })
      }
    }

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
      const resource = URI.file(path.join(root.fsPath, relPath))
      const key = resource.toString()
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
      dirtyKeys.add(key)
      emitProgress()
      flushResults()
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
      const listeners = new DisposableStore()
      listeners.add(child.onStdout((data: Buffer) => handleData(decoder.write(data))))
      listeners.add(
        child.onStderr((data: Buffer) => {
          const next = data.toString()
          if (stderr.length + next.length < STDERR_LIMIT) stderr += next
        }),
      )
      listeners.add(
        child.onDidExit((exit) => {
          this._sessions.delete(query.sessionId)
          listeners.dispose()
          child.dispose()
          if (exit.error !== undefined) {
            reject(new Error(exit.error))
            return
          }
          const code = exit.code
          handleData(decoder.end())
          if (remainder.trim().length > 0) {
            handleLine(remainder.trim())
            remainder = ''
          }
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
            const fatal = rgErrorMsgForDisplay(stderr)
            if (fatal !== undefined) {
              reject(new Error(fatal))
              return
            }
            // Non-fatal exit (e.g. an unreadable path or broken symlink): the
            // rest of the tree was searched, so keep the results and only log.
            if (stderr.trim().length > 0) {
              this._logger.warn(
                `textSearch ignored non-fatal rg exit code=${code}: ` +
                  errorMessageFromRipgrep(stderr, `ripgrep exited with code ${code}`),
              )
            }
          }

          resolve({
            results: [...results.values()],
            progress,
            durationMs,
          })
        }),
      )
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
      session.process.dispose()
    }
    this._sessions.clear()
    super.dispose()
  }
}
