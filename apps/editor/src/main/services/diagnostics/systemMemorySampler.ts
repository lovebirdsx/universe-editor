/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Windows system memory readings for the memory-forensics path.
 *
 *  两个数经常被混为一谈，而它们回答的是不同问题：`AvailableBytes` 是空闲**物理**内存，堆快照
 *  需要的提交余量是 `CommitLimit − CommittedBytes`。一台机器可能只剩 200MB 空闲物理内存却仍有
 *  12GB 提交余量（页面文件刚被撑大时也会反过来），混用会放进一份系统根本背不起的快照，或者
 *  拒掉一份背得起的。
 *
 *  读数靠起一个 `powershell.exe` 拿，所以怎么都是尽力而为：单航班、硬超时、输出上限、失败指数
 *  退避但永不放弃（对着一台 WMI 坏掉的机器每分钟起一个进程是不可接受的）。启动路径上没有任何
 *  地方 await 它。
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import type { ILogger } from '@universe-editor/platform'

/** A single query may run this long before the child is killed. */
export const COMMIT_QUERY_TIMEOUT_MS = 5_000

/** Cap on the query's stdout — the payload is one short JSON object. */
export const COMMIT_QUERY_MAX_OUTPUT_BYTES = 64 * 1024

/** Cadence after a successful reading. */
export const SYSTEM_MEMORY_INTERVAL_MS = 60_000

/** Ceiling for the failure backoff; a broken WMI must not spawn every minute forever. */
export const SYSTEM_MEMORY_MAX_BACKOFF_MS = 10 * 60_000

/** 比这更旧的读数算 `stale` 不算 `ok`：提交压力以秒计地变，两分钟前的「还空 12GB」说明不了现在。 */
export const COMMIT_READING_FRESH_MS = 90_000

/**
 * 固定命令、不过 shell、不改执行策略（内联管道的 `-Command` 不受脚本策略限制）。这三个字段就是
 * 本模块存在的理由；`ConvertTo-Json` 让解析只剩一次 `JSON.parse`，不用去抠表格文本。
 */
export const WINDOWS_COMMIT_QUERY =
  'Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory | ' +
  'Select-Object CommittedBytes,CommitLimit,AvailableBytes | ConvertTo-Json -Compress'

const WINDOWS_POWERSHELL = 'powershell.exe'
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COMMIT_QUERY]
const DETAIL_MAX_CHARS = 120

export type SystemMemoryStatus =
  /** A reading landed inside the freshness window. */
  | 'ok'
  /** A reading exists but is older than the freshness window. */
  | 'stale'
  /** Nothing has been read yet, or every attempt so far failed (see `detail`). */
  | 'unknown'
  /** The platform has no commit accounting (non-Windows). Not an error. */
  | 'unsupported'

export interface SystemCommitReading {
  /** Windows `CommittedBytes`. */
  readonly committedBytes: number
  /** Windows `CommitLimit`. */
  readonly commitLimitBytes: number
  /** `commitLimit − committed`, clamped at 0 — what a snapshot could still commit. */
  readonly commitHeadroomBytes: number
}

export interface SystemMemorySample {
  readonly status: SystemMemoryStatus
  /** Epoch ms the reading describes; 0 when nothing was ever read. */
  readonly at: number
  /** Age of the reading at the moment this sample was produced. */
  readonly ageMs: number
  /** Present for `ok` / `stale`; undefined while `unknown` or `unsupported`. */
  readonly commit?: SystemCommitReading
  /**
   * Free **physical** memory. On Windows this is the query's `AvailableBytes`; it
   * is *not* `commitLimit − committedBytes` and the two must not be swapped.
   */
  readonly availablePhysicalBytes?: number
  readonly totalPhysicalBytes?: number
  /** Why a non-`ok` sample reads the way it does, or the last failed attempt. */
  readonly detail?: string
}

export interface CommitQueryOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** Injection seam: resolves to the command's raw stdout. */
export type CommitQueryRunner = (options: CommitQueryOptions) => Promise<string>

export interface SystemMemorySamplerOptions {
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly query?: CommitQueryRunner
  readonly logger?: ILogger
  readonly intervalMs?: number
  readonly maxBackoffMs?: number
  readonly timeoutMs?: number
  readonly freshMs?: number
  readonly readPhysical?: () => { readonly freeBytes: number; readonly totalBytes: number }
}

/**
 * 连续失败 N 次后等这么久再试，封顶 `maxMs`：120s、240s、480s，然后 10 分钟。频率有界，但也
 * 永不放弃。
 */
export function systemMemoryBackoffMs(
  consecutiveFailures: number,
  baseMs = SYSTEM_MEMORY_INTERVAL_MS,
  maxMs = SYSTEM_MEMORY_MAX_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return baseMs
  return Math.min(baseMs * 2 ** consecutiveFailures, maxMs)
}

/** 只拒绝明显荒谬的读数：字段缺失、不是非负安全整数、整段不是 JSON——一律读成「未知」。 */
function commitBytes(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  // PowerShell occasionally stringifies 64-bit counters.
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

export interface WindowsCommitPayload {
  readonly commit: SystemCommitReading
  /** `AvailableBytes` — free physical memory, kept apart from commit headroom. */
  readonly availablePhysicalBytes?: number
}

/** 解析查询的 stdout。数组也容忍（这按单例 perf 类只回一个对象，但取第一个元素不吃亏）。 */
export function parseWindowsCommitOutput(raw: string): WindowsCommitPayload | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (first === null || typeof first !== 'object') return undefined
  const fields = first as Record<string, unknown>
  const committedBytes = commitBytes(fields['CommittedBytes'])
  const commitLimitBytes = commitBytes(fields['CommitLimit'])
  if (committedBytes === undefined || commitLimitBytes === undefined) return undefined
  const available = commitBytes(fields['AvailableBytes'])
  return {
    commit: {
      committedBytes,
      commitLimitBytes,
      // 夹到 0 而不是拒绝：提交量超过上限是真实（且刺眼）的状态——页面文件再也撑不大了——而闸门
      // 正需要听到「一点余量都没有了」。
      commitHeadroomBytes: Math.max(0, commitLimitBytes - committedBytes),
    },
    ...(available === undefined ? {} : { availablePhysicalBytes: available }),
  }
}

/** Strips anything that could forge or break a log line, and caps the length. */
function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const flat = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\|/g, '/')
    .trim()
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS)}…` : flat
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/** 两个消费者共用的一行：周期性 `processMetrics` 与诊断包的 `memory.txt`——同键同单位，两边读数可直接比对。 */
export function formatSystemMemoryLine(sample: SystemMemorySample): string {
  const parts: string[] = [`status=${sample.status}`]
  if (sample.status === 'stale') parts.push(`age=${Math.round(sample.ageMs / 1000)}s`)
  if (sample.commit) {
    parts.push(`committed=${megabytes(sample.commit.committedBytes)}MB`)
    parts.push(`commitLimit=${megabytes(sample.commit.commitLimitBytes)}MB`)
    parts.push(`commitHeadroom=${megabytes(sample.commit.commitHeadroomBytes)}MB`)
  }
  if (sample.availablePhysicalBytes !== undefined) {
    parts.push(`availablePhysical=${megabytes(sample.availablePhysicalBytes)}MB`)
  }
  if (sample.totalPhysicalBytes !== undefined) {
    parts.push(`totalPhysical=${megabytes(sample.totalPhysicalBytes)}MB`)
  }
  if (sample.detail !== undefined) parts.push(`detail=${describeError(sample.detail)}`)
  return `system-memory ${parts.join(' ')}`
}

/** Default runner: `execFile`, no shell, output capped, killed on abort/timeout. */
export function createWindowsCommitQueryRunner(): CommitQueryRunner {
  return ({ timeoutMs, signal }) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        WINDOWS_POWERSHELL,
        POWERSHELL_ARGS,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: COMMIT_QUERY_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          signal,
        },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        },
      )
    })
}

interface Reading {
  readonly at: number
  readonly commit: SystemCommitReading
}

interface PhysicalReading {
  readonly at: number
  readonly freeBytes: number
  readonly totalBytes: number
}

/** 每进程一个，指标日志与快照闸门共用：两个实例会各起一个 PowerShell，并对同一台机器在同一秒给出不同答案。 */
export class SystemMemorySampler {
  private readonly _platform: NodeJS.Platform
  private readonly _now: () => number
  private readonly _query: CommitQueryRunner
  private readonly _logger: ILogger | undefined
  private readonly _intervalMs: number
  private readonly _maxBackoffMs: number
  private readonly _timeoutMs: number
  private readonly _freshMs: number
  private readonly _readPhysical: () => { freeBytes: number; totalBytes: number }

  private _started = false
  private _disposed = false
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _inflight: Promise<void> | undefined
  private _abort: AbortController | undefined
  private _reading: Reading | undefined
  private _physical: PhysicalReading | undefined
  private _failure: { at: number; detail: string } | undefined
  private _failures = 0
  private _nextAttemptAt = 0
  private _loggedFailure: string | undefined

  constructor(options: SystemMemorySamplerOptions = {}) {
    this._platform = options.platform ?? process.platform
    this._now = options.now ?? (() => Date.now())
    this._query = options.query ?? createWindowsCommitQueryRunner()
    this._logger = options.logger
    this._intervalMs = options.intervalMs ?? SYSTEM_MEMORY_INTERVAL_MS
    this._maxBackoffMs = options.maxBackoffMs ?? SYSTEM_MEMORY_MAX_BACKOFF_MS
    this._timeoutMs = options.timeoutMs ?? COMMIT_QUERY_TIMEOUT_MS
    this._freshMs = options.freshMs ?? COMMIT_READING_FRESH_MS
    this._readPhysical =
      options.readPhysical ?? (() => ({ freeBytes: freemem(), totalBytes: totalmem() }))
  }

  get disposed(): boolean {
    return this._disposed
  }

  /** Consecutive failed attempts — the backoff input. Reset by any success. */
  get failures(): number {
    return this._failures
  }

  /** 开始采样。幂等，且刻意不在任何地方被 await：第一次查询要起进程，启动路径不能等它。 */
  start(): void {
    if (this._started || this._disposed) return
    this._started = true
    void this._runAttempt()
  }

  /** 缓存读数——绝不起进程、绝不阻塞。`maxAgeMs` 是新鲜度界：超过它状态为 `stale`，调用方须当成「判不了」而不是一个数。 */
  latest(maxAgeMs: number = this._freshMs): SystemMemorySample {
    return this._sampleAt(this._now(), maxAgeMs)
  }

  /**
   * 与 {@link latest} 相同，但缓存不新鲜且退避窗口已过时顺手起一次查询。仍然立刻返回——调用方在
   * 下个样本上再读，所以这里不返回 promise。
   */
  ensureFresh(maxAgeMs: number = this._freshMs): SystemMemorySample {
    const now = this._now()
    const sample = this._sampleAt(now, maxAgeMs)
    if (sample.status !== 'ok') this._refreshIfDue(now)
    return sample
  }

  /** Clear the timer, kill any in-flight child, and drop everything it returns. */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    this._abort?.abort()
    this._abort = undefined
  }

  private _sampleAt(now: number, maxAgeMs: number): SystemMemorySample {
    const physical = this._physical
    const physicalFields =
      physical === undefined
        ? {}
        : {
            availablePhysicalBytes: physical.freeBytes,
            totalPhysicalBytes: physical.totalBytes,
          }
    if (this._platform !== 'win32') {
      return {
        status: 'unsupported',
        at: physical?.at ?? 0,
        ageMs: physical === undefined ? 0 : Math.max(0, now - physical.at),
        ...physicalFields,
        detail: 'commit accounting is Windows-only',
      }
    }
    const reading = this._reading
    if (reading === undefined) {
      return {
        status: 'unknown',
        at: this._failure?.at ?? 0,
        ageMs: 0,
        ...physicalFields,
        detail: this._failure?.detail ?? 'no reading yet',
      }
    }
    const ageMs = Math.max(0, now - reading.at)
    return {
      status: ageMs > maxAgeMs ? 'stale' : 'ok',
      at: reading.at,
      ageMs,
      commit: reading.commit,
      ...physicalFields,
      // A reading that is still fresh stays `ok`; a failed attempt after it is
      // context, not a status change.
      ...(this._failure === undefined
        ? {}
        : { detail: `last attempt failed: ${this._failure.detail}` }),
    }
  }

  private _refreshIfDue(now: number): void {
    if (this._disposed || this._inflight !== undefined) return
    if (now < this._nextAttemptAt) return
    void this._runAttempt()
  }

  /** Single flight: concurrent callers share the attempt already in progress. */
  private _runAttempt(): Promise<void> {
    const existing = this._inflight
    if (existing !== undefined) return existing
    const abort = new AbortController()
    this._abort = abort
    // 延后到微任务再执行：非 Windows 的路径没有任何 await，同步跑完会让 finally 抢在
    // `this._inflight = attempt` 之前执行，占位符再也清不掉（此后永远不刷新）。
    const attempt = Promise.resolve().then(() => this._attempt(abort))
    this._inflight = attempt
    return attempt
  }

  private async _attempt(abort: AbortController): Promise<void> {
    let delayMs = this._intervalMs
    try {
      // 守卫放在 try 里：占位符、定时器和退避都归 finally 管，提前退出也要交还。
      if (this._disposed || abort.signal.aborted) return
      if (this._platform !== 'win32') {
        this._recordPhysical()
      } else {
        const stdout = await this._query({ timeoutMs: this._timeoutMs, signal: abort.signal })
        // dispose 之后（或子进程已被杀之后）才落地的结果属于一次我们已经放弃的查询；写进去会让
        // 下一段会话读到一个已经不存在的进程给出的数。
        if (this._disposed || abort.signal.aborted) return
        const payload = parseWindowsCommitOutput(stdout)
        if (payload === undefined) throw new Error('unparseable commit payload')
        this._reading = { at: this._now(), commit: payload.commit }
        this._recordPhysical(payload.availablePhysicalBytes)
        this._failure = undefined
        if (this._failures > 0) {
          this._logger?.info(`system commit readings recovered after ${this._failures} failures`)
        }
        this._failures = 0
        this._loggedFailure = undefined
      }
    } catch (err) {
      if (this._disposed || abort.signal.aborted) return
      this._failures += 1
      const detail = describeError(err)
      this._failure = { at: this._now(), detail }
      delayMs = systemMemoryBackoffMs(this._failures, this._intervalMs, this._maxBackoffMs)
      // Folded: the same broken WMI repeats every cycle, and one line per distinct
      // reason is what separates a persistently broken query from a flapping one.
      if (this._loggedFailure !== detail) {
        this._loggedFailure = detail
        this._logger?.warn(`system commit query failed (attempt ${this._failures}): ${detail}`)
      }
    } finally {
      if (this._abort === abort) {
        this._abort = undefined
        this._inflight = undefined
        this._nextAttemptAt = this._now() + delayMs
        this._scheduleNext(delayMs)
      }
    }
  }

  /**
   * 查询自带 `AvailableBytes` 时用它：两个数落在同一瞬间，而不是相隔一次进程启动的两次读数。
   */
  private _recordPhysical(availablePhysicalBytes?: number): void {
    let physical: { freeBytes: number; totalBytes: number } | undefined
    try {
      physical = this._readPhysical()
    } catch {
      // Physical memory is context; it must never be the reason a status flips.
    }
    const freeBytes = availablePhysicalBytes ?? physical?.freeBytes
    if (freeBytes === undefined) return
    this._physical = {
      at: this._now(),
      freeBytes,
      totalBytes: physical?.totalBytes ?? 0,
    }
  }

  private _scheduleNext(delayMs: number): void {
    if (this._disposed) return
    if (this._timer !== undefined) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = undefined
      void this._runAttempt()
    }, delayMs)
    this._timer.unref()
  }
}

let sharedSampler: SystemMemorySampler | undefined

/** 进程级单例，首次使用时创建并启动：指标日志与快照闸门读的是同一份读数，而不是两个实例各起一次查询。 */
export function getSharedSystemMemorySampler(): SystemMemorySampler {
  if (sharedSampler === undefined || sharedSampler.disposed) {
    sharedSampler = new SystemMemorySampler()
    sharedSampler.start()
  }
  return sharedSampler
}

/** Test/DI seam: install a sampler built with injected seams, or `undefined` to clear. */
export function setSharedSystemMemorySampler(sampler: SystemMemorySampler | undefined): void {
  if (sharedSampler === sampler) return
  sharedSampler?.dispose()
  sharedSampler = sampler
  sampler?.start()
}

/** App quit: stop the timer and the child process behind it. */
export function disposeSharedSystemMemorySampler(): void {
  sharedSampler?.dispose()
  sharedSampler = undefined
}
