/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Append-only run history at `<userData>/triggers/history.jsonl`. Rotates to
 *  `history.jsonl.1` … `.N` once the current file reaches the size cap.
 *
 *  One line per finished run: identity, timing, outcome and the verdict synopsis
 *  only. Event payloads, prompts and agent output are never written here.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ILogger } from '@universe-editor/platform'
import type {
  TriggerRunFilter,
  TriggerRunHistoryEntry,
  TriggerRunOutcome,
  TriggerVerdictKind,
} from '../../../shared/triggers/types.js'

export const TRIGGER_HISTORY_MAX_BYTES = 1024 * 1024
export const TRIGGER_HISTORY_ROTATED_FILES = 3
export const TRIGGER_HISTORY_DEFAULT_LIMIT = 100
export const TRIGGER_HISTORY_MAX_LIMIT = 500

const RUN_OUTCOMES: readonly TriggerRunOutcome[] = [
  'completed',
  'budget-exceeded',
  'timeout',
  'approval-timeout',
  'cancelled',
  'failed',
]

const VERDICT_KINDS: readonly TriggerVerdictKind[] = ['auto-approve', 'escalate', 'reject', 'info']

export interface TriggerHistoryStoreOptions {
  readonly file: string
  readonly logger: ILogger
  readonly maxBytes?: number
  /** Number of rotated generations kept (`history.jsonl.1` … `.N`). */
  readonly maxFiles?: number
}

export class TriggerHistoryStore {
  private readonly _file: string
  private readonly _logger: ILogger
  private readonly _maxBytes: number
  private readonly _maxFiles: number
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(options: TriggerHistoryStoreOptions) {
    this._file = options.file
    this._logger = options.logger
    this._maxBytes = Math.max(1, options.maxBytes ?? TRIGGER_HISTORY_MAX_BYTES)
    this._maxFiles = Math.max(1, options.maxFiles ?? TRIGGER_HISTORY_ROTATED_FILES)
  }

  /** Serialized with `recent` / `flush` so a read never races the write queue. */
  append(entry: TriggerRunHistoryEntry): Promise<void> {
    return this._enqueue(async () => {
      const line = `${JSON.stringify(entry)}\n`
      await mkdir(dirname(this._file), { recursive: true })
      await this._rotateIfNeeded(Buffer.byteLength(line))
      await appendFile(this._file, line, { encoding: 'utf8', mode: 0o600 })
    })
  }

  /** Newest first. Malformed / unknown-enum lines are skipped; `limit` caps at 500. */
  recent(filter: TriggerRunFilter = {}): Promise<readonly TriggerRunHistoryEntry[]> {
    const limit = clampLimit(filter.limit)
    return this._enqueue(async () => {
      const lines: string[] = []
      // Oldest generation first, so `slice(-limit)` keeps the newest rows.
      for (let index = this._maxFiles; index >= 1; index -= 1) {
        lines.push(...(await this._readLines(`${this._file}.${index}`)))
      }
      lines.push(...(await this._readLines(this._file)))
      const entries: TriggerRunHistoryEntry[] = []
      for (const line of lines) {
        if (line.trim() === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // A torn final line after a crash is not a history failure.
          continue
        }
        const entry = toHistoryEntry(parsed)
        if (entry === undefined || !matchesFilter(entry, filter)) continue
        entries.push(entry)
      }
      return entries.slice(-limit).reverse()
    })
  }

  /** Resolves once every queued write has settled; safe to call from dispose. */
  flush(): Promise<void> {
    return this._queue.then(
      () => undefined,
      () => undefined,
    )
  }

  private async _readLines(file: string): Promise<string[]> {
    try {
      return (await readFile(file, 'utf8')).split('\n')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this._logger.warn(`run history is unreadable (${file}): ${describeError(err)}`)
      return []
    }
  }

  private async _rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0
    try {
      size = (await stat(this._file)).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return
    }
    if (size === 0 || size + incomingBytes <= this._maxBytes) return

    await rm(`${this._file}.${this._maxFiles}`, { force: true })
    for (let index = this._maxFiles - 1; index >= 1; index -= 1) {
      await moveIfExists(`${this._file}.${index}`, `${this._file}.${index + 1}`)
    }
    await rename(this._file, `${this._file}.1`)
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task)
    this._queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TRIGGER_HISTORY_DEFAULT_LIMIT
  return Math.min(TRIGGER_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

function matchesFilter(entry: TriggerRunHistoryEntry, filter: TriggerRunFilter): boolean {
  if (filter.triggerKey !== undefined && entry.triggerKey !== filter.triggerKey) return false
  if (filter.workspace !== undefined && entry.workspace !== filter.workspace) return false
  return filter.outcome === undefined || entry.outcome === filter.outcome
}

/** Strict shape check: one bad field drops the whole line. */
function toHistoryEntry(value: unknown): TriggerRunHistoryEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const runId = nonEmptyString(record['runId'])
  const triggerKey = nonEmptyString(record['triggerKey'])
  const triggerId = nonEmptyString(record['triggerId'])
  const triggerName = nonEmptyString(record['triggerName'])
  const workspace = nonEmptyString(record['workspace'])
  const workspaceName = nonEmptyString(record['workspaceName'])
  const startedAt = finiteNumber(record['startedAt'])
  const endedAt = finiteNumber(record['endedAt'])
  const outcome = asEnum(record['outcome'], RUN_OUTCOMES)
  if (
    runId === undefined ||
    triggerKey === undefined ||
    triggerId === undefined ||
    triggerName === undefined ||
    workspace === undefined ||
    workspaceName === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    outcome === undefined
  ) {
    return undefined
  }
  const sessionId = optionalText(record['sessionId'])
  if (sessionId === INVALID) return undefined
  const verdictRaw = record['verdict']
  const verdict = verdictRaw === undefined ? undefined : asEnum(verdictRaw, VERDICT_KINDS)
  if (verdictRaw !== undefined && verdict === undefined) return undefined
  // An empty summary is a valid verdict outcome, so keep it instead of dropping the row.
  const summary = optionalText(record['summary'])
  if (summary === INVALID) return undefined
  const error = optionalText(record['error'])
  if (error === INVALID) return undefined
  const costUsd = optionalNumber(record['costUsd'])
  if (record['costUsd'] !== undefined && costUsd === undefined) return undefined
  const durationMs = optionalNumber(record['durationMs'])
  if (record['durationMs'] !== undefined && durationMs === undefined) return undefined
  return {
    runId,
    triggerKey,
    triggerId,
    triggerName,
    workspace,
    workspaceName,
    ...(sessionId === undefined ? {} : { sessionId }),
    startedAt,
    endedAt,
    outcome,
    ...(verdict === undefined ? {} : { verdict }),
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const INVALID = Symbol('invalid')

/** Present-but-wrong-type values invalidate the line; empty strings are kept. */
function optionalText(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : INVALID
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  return finiteNumber(value)
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function moveIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}
