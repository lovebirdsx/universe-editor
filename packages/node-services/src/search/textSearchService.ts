/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace text search backed by ripgrep. Electron-free so apps/editor main
 *  and a remote Node server share the same engine.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  ITextSearchMainService,
  URI,
  type IFileMatch,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchMainComplete,
  type ITextSearchMainProgressEvent,
  type ITextSearchMainQuery,
  type ITextSearchMainResultsEvent,
  type ITextSearchMatch,
  type ITextSearchProgress,
  type ITextSearchRange,
  type SearchLimitHit,
  type UriComponents,
} from '@universe-editor/platform'
import { ManagedChildProcess } from '../process/managedChildProcess.js'
import {
  escapeForRegex,
  expandExcludeGlob,
  expandIncludeGlob,
  resolveSearchThreads,
  rgDiskPath,
} from './ripgrepUtil.js'

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

// Shared rg path/glob/thread policy now lives in ripgrepUtil.ts (also used by
// the file-name search); re-exported here to keep existing import sites stable.
export { resolveRipgrepDiskPath, resolveSearchThreads } from './ripgrepUtil.js'

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
  readonly processes: Set<ManagedChildProcess>
  cancelled: boolean
  killedForLimit: boolean
}

function reviveUri(value: URI | UriComponents | string): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value) as URI
}

export function buildRgArgs(query: ITextSearchMainQuery): string[] {
  const args = ['--hidden', '--no-require-git', '--json']
  // Honouring .gitignore is the VSCode default: without it every search also
  // walks .git/ and whatever the ignore files list, which dominates the scan
  // time on large repos (the configured excludes do not cover .git).
  if (query.useIgnoreFiles !== true) {
    args.push('--no-ignore', '--no-ignore-global')
  }
  args.push('--follow')
  args.push(query.matchCase ? '--case-sensitive' : '--ignore-case')
  args.push('--crlf')
  args.push('--threads', String(resolveSearchThreads(query.threads)))
  args.push('--max-filesize', String(query.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES))
  if (query.maxDepth !== undefined) {
    args.push('--max-depth', String(query.maxDepth))
  }

  for (const include of query.includes.flatMap(expandIncludeGlob)) {
    args.push('-g', include)
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
  // 多个位置参数一次 spawn：rg 输出的 path 相对 cwd，解析无需感知扫描范围。
  const scanPaths = query.scanPaths && query.scanPaths.length > 0 ? [...query.scanPaths] : ['.']
  args.push(...scanPaths)
  return args
}

function bytesOrTextToString(value: RgBytesOrText): string {
  if ('bytes' in value) return Buffer.from(value.bytes, 'base64').toString()
  return value.text
}

/**
 * ripgrep reports column offsets in UTF-8 bytes; the editor needs UTF-16 code
 * units. Converting by encoding the whole line and measuring a prefix costs
 * O(line length) per submatch, which turns pathological on the long single-line
 * files a short query inevitably hits: one `.tsbuildinfo` is a single 373KB
 * line and a two-letter query matches it hundreds of times. Measured on this
 * repo, a query like "he" pushed ~90MB through `Buffer.from` and stalled the
 * main process for 3+ seconds — the whole window froze.
 *
 * Two properties make it cheap instead. Lines that are pure ASCII (which every
 * pathological case here is — `.tsbuildinfo` and source maps are ASCII JSON)
 * have column === byteOffset + 1, so one `Buffer.byteLength` per *line* settles
 * every submatch in O(1). Otherwise offsets within a line arrive in increasing
 * order, so a single cursor walks the line once per line rather than once per
 * submatch, restarting only if a caller ever goes backwards.
 */
export function createColumnMapper(line: string): (byteOffset: number) => number {
  if (Buffer.byteLength(line) === line.length) {
    return (byteOffset) => (byteOffset <= 0 ? 1 : Math.min(byteOffset, line.length) + 1)
  }
  let cursorBytes = 0
  let cursorUnits = 0
  return (byteOffset) => {
    if (byteOffset <= 0) return 1
    if (byteOffset < cursorBytes) {
      cursorBytes = 0
      cursorUnits = 0
    }
    while (cursorBytes < byteOffset && cursorUnits < line.length) {
      const code = line.charCodeAt(cursorUnits)
      if (code < 0x80) {
        cursorBytes += 1
        cursorUnits += 1
      } else if (code < 0x800) {
        cursorBytes += 2
        cursorUnits += 1
      } else if (code >= 0xd800 && code <= 0xdbff && cursorUnits + 1 < line.length) {
        const next = line.charCodeAt(cursorUnits + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          // Surrogate pair: one 4-byte code point spanning two UTF-16 units.
          cursorBytes += 4
          cursorUnits += 2
        } else {
          cursorBytes += 3
          cursorUnits += 1
        }
      } else {
        cursorBytes += 3
        cursorUnits += 1
      }
    }
    return cursorUnits + 1
  }
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

export class TextSearchService extends Disposable implements ITextSearchMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _sessions = new Map<string, RunningSearch>()
  protected readonly _onDidSearchProgress = this._register(
    new Emitter<ITextSearchMainProgressEvent>(),
  )
  readonly onDidSearchProgress = this._onDidSearchProgress.event
  protected readonly _onDidSearchResults = this._register(
    new Emitter<ITextSearchMainResultsEvent>(),
  )
  readonly onDidSearchResults = this._onDidSearchResults.event

  constructor(loggerService?: ILoggerServiceType) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'textSearch', name: 'Text Search' })
  }

  async search(query: ITextSearchMainQuery): Promise<ITextSearchMainComplete> {
    const root = reviveUri(query.root)
    // 本机 ripgrep 只搜 file: 目录；远端工作区由远端 search 服务接管，fail loud。
    if (root.scheme !== 'file') {
      throw new Error(`textSearch: unsupported scheme: ${root.scheme}`)
    }
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
        `excludes=${query.excludes.length} configExcludes=${query.configurationExcludes.length} ` +
        `threads=${resolveSearchThreads(query.threads)}`,
    )

    const running: RunningSearch = {
      processes: new Set(),
      cancelled: false,
      killedForLimit: false,
    }
    this._sessions.set(query.sessionId, running)

    const results = new Map<string, IFileMatch>()
    const fileMatchCounts = new Map<string, number>()
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS
    const maxMatchesPerFile = query.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE
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
      for (const process of running.processes) process.kill()
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
      const columnAt = createColumnMapper(line)

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
          startColumn: columnAt(submatch.start),
          endColumn: columnAt(submatch.end),
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
        filesScanned += (message.data as RgSummaryData | undefined)?.stats?.searches ?? 0
      }
    }

    // 一次 spawn 跑完所有 scanPaths（rg 原生多位置参数）；聚焦且 showRootFiles
    // 时根的直接文件在任何 scan path 之外，补一次浅层扫描（毫秒级）合并结果。
    // 顺序执行让 limit 状态自然共享：主扫描先占额度，根扫描随后。
    const runChild = (childArgs: string[], label: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const child = new ManagedChildProcess(
          spawn(rgDiskPath, childArgs, { cwd: root.fsPath, windowsHide: true }),
          {
            logger: this._logger,
            label: `${query.sessionId}:${label}`,
          },
        )
        running.processes.add(child)
        const decoder = new StringDecoder('utf8')
        let remainder = ''
        let stderr = ''
        const handleData = (chunk: string): void => {
          const data = remainder + chunk
          const lines = data.split(/\r?\n/)
          remainder = lines.pop() ?? ''
          for (const line of lines) handleLine(line.trim())
        }
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
            running.processes.delete(child)
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
            resolve()
          }),
        )
      })

    const spawns: { args: string[]; label: string }[] = [{ args, label: 'scan' }]
    if (query.rootFilesInScope === true && (query.scanPaths?.length ?? 0) > 0) {
      spawns.push({
        args: buildRgArgs({
          ...query,
          pattern,
          scanPaths: [],
          rootFilesInScope: false,
          maxDepth: 1,
        }),
        label: 'rootFiles',
      })
    }

    let searchError: Error | undefined
    for (const spawnSpec of spawns) {
      if (running.cancelled || running.killedForLimit) break
      try {
        await runChild(spawnSpec.args, spawnSpec.label)
      } catch (err) {
        searchError = err as Error
        break
      }
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

    if (searchError !== undefined) throw searchError
    return {
      results: [...results.values()],
      progress,
      durationMs,
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) return
    session.cancelled = true
    for (const process of session.processes) process.kill()
  }

  override dispose(): void {
    for (const session of this._sessions.values()) {
      session.cancelled = true
      for (const process of session.processes) process.dispose()
    }
    this._sessions.clear()
    super.dispose()
  }
}
