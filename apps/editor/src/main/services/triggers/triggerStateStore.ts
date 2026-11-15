/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owner of `<userData>/triggers/state.json`: dedupe keys, pause flags, failure
 *  backoff and the baseline markers. The service is the only writer; writes are
 *  debounced and atomic (0600). Pending-event payloads deliberately live in separate
 *  files (`pending/<runId>.json`, owned by TriggerMainService), never here.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import type { ILogger } from '@universe-editor/platform'
import type { ProcessedKeys } from '../../../shared/triggers/dedupe.js'
import type { TriggerRunOutcome, TriggerVerdictKind } from '../../../shared/triggers/types.js'
import { writeJsonAtomic } from '../jsonConfig/atomicFile.js'

export interface TriggerRuntimeState {
  readonly processed: ProcessedKeys
  readonly paused: boolean
  /** Paused automatically by the failure threshold; cleared by a manual resume or a success. */
  readonly autoPaused?: boolean
  readonly consecutiveFailures: number
  readonly backoffUntil?: number
  readonly lastScheduledAt?: number
  readonly lastRunAt?: number
  readonly lastError?: string
  /** Summary of the most recent run, rendered in the trigger manager's overview. */
  readonly lastRunId?: string
  readonly lastSessionId?: string
  readonly lastRunOutcome?: TriggerRunOutcome
  readonly lastRunVerdict?: TriggerVerdictKind
  readonly lastRunSummary?: string
  readonly lastRunCostUsd?: number
  readonly lastRunDurationMs?: number
  /** poll / event: the first observed result only seeds the dedupe keys. */
  readonly baselineDone: boolean
  /** Normalized fingerprint of the trigger `source`; a change resets the baseline. */
  readonly sourceFingerprint?: string
  /** Config fingerprint the user confirmed for running this workspace-defined trigger. */
  readonly activationConfirmed?: string
}

/** A queued event whose payload is on disk; re-enqueued once the service restarts. */
export interface PendingRunRecord {
  readonly runId: string
  /** Composite workspace + trigger id; a bare id collides across workspaces. */
  readonly triggerKey: string
  readonly eventKey: string
  readonly firedAt: number
}

export interface TriggerStateFile {
  readonly version: 2
  readonly pausedAll: boolean
  readonly triggers: Readonly<Record<string, TriggerRuntimeState>>
  readonly pending: readonly PendingRunRecord[]
}

export const DEFAULT_TRIGGER_RUNTIME_STATE: TriggerRuntimeState = {
  processed: {},
  paused: false,
  consecutiveFailures: 0,
  baselineDone: false,
}

export function createEmptyTriggerStateFile(): TriggerStateFile {
  return { version: 2, pausedAll: false, triggers: {}, pending: [] }
}

/** Timer abstraction so tests can drive the debounce on a fake clock. */
export interface TriggerStateTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TriggerStateStoreOptions {
  readonly file: string
  readonly logger: ILogger
  readonly now?: () => number
  readonly debounceMs?: number
  /** Defaults to the host timers; the trigger scheduler injects its own clock. */
  readonly timers?: TriggerStateTimers
}

const DEFAULT_DEBOUNCE_MS = 200

export class TriggerStateStore {
  private readonly _file: string
  private readonly _logger: ILogger
  private readonly _now: () => number
  private readonly _debounceMs: number
  private readonly _timers: TriggerStateTimers
  private _state: TriggerStateFile = createEmptyTriggerStateFile()
  private _timer: unknown
  private _serial: Promise<void> = Promise.resolve()
  private _disposed = false

  constructor(options: TriggerStateStoreOptions) {
    this._file = options.file
    this._logger = options.logger
    this._now = options.now ?? Date.now
    this._debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this._timers = options.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  }

  get state(): TriggerStateFile {
    return this._state
  }

  async load(): Promise<TriggerStateFile> {
    try {
      const text = await readFile(this._file, 'utf8')
      this._state = sanitizeLoadedState(normalizeTriggerStateFile(JSON.parse(text)), this._logger)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this._logger.warn(`state.json is unreadable; starting empty: ${describeError(err)}`)
      }
      this._state = createEmptyTriggerStateFile()
    }
    return this._state
  }

  /** Replaces the snapshot and schedules a debounced write. */
  set(next: TriggerStateFile): void {
    this._state = next
    if (this._disposed) return
    this._scheduleWrite()
  }

  /** Writes immediately if a write is pending; safe to call from dispose. */
  flush(): Promise<void> {
    if (this._timer !== undefined) {
      this._timers.clearTimeout(this._timer)
      this._timer = undefined
    }
    return this._enqueue(() => writeJsonAtomic(this._file, this._state))
  }

  /** Like {@link flush} but does not touch the disk when nothing is pending. */
  flushIfPending(): Promise<void> {
    if (this._timer !== undefined) return this.flush()
    // A timer that already fired may still have its write in flight.
    return this._serial
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._timer !== undefined) {
      this._timers.clearTimeout(this._timer)
      this._timer = undefined
    }
    void this.flush().catch((err) =>
      this._logger.warn(`state.json flush failed: ${describeError(err)}`),
    )
  }

  private _scheduleWrite(): void {
    if (this._timer !== undefined) this._timers.clearTimeout(this._timer)
    this._timer = this._timers.setTimeout(() => {
      this._timer = undefined
      void this._enqueue(() => writeJsonAtomic(this._file, this._state)).catch((err) =>
        this._logger.warn(`state.json write failed: ${describeError(err)}`),
      )
    }, this._debounceMs)
    ;(this._timer as { unref?: () => void } | undefined)?.unref?.()
  }

  private _enqueue(task: () => Promise<void>): Promise<void> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const TRIGGER_RUN_OUTCOMES: readonly TriggerRunOutcome[] = [
  'completed',
  'budget-exceeded',
  'timeout',
  'approval-timeout',
  'cancelled',
  'failed',
]

const TRIGGER_VERDICT_KINDS: readonly TriggerVerdictKind[] = ['info', 'escalate']

/** A hand-edited state file must not smuggle in an enum value the UI cannot render. */
function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function normalizeProcessed(raw: unknown): ProcessedKeys {
  if (!isRecord(raw)) return {}
  const processed: Record<string, { at: number; status: 'queued' | 'started' }> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue
    const at = finiteNumber(entry['at'])
    const status = entry['status']
    if (at === undefined) continue
    if (status !== 'queued' && status !== 'started') continue
    processed[key] = { at, status }
  }
  return processed
}

function normalizeRuntimeState(raw: unknown): TriggerRuntimeState {
  if (!isRecord(raw)) return DEFAULT_TRIGGER_RUNTIME_STATE
  const consecutiveFailures = finiteNumber(raw['consecutiveFailures'])
  const backoffUntil = finiteNumber(raw['backoffUntil'])
  const lastScheduledAt = finiteNumber(raw['lastScheduledAt'])
  const lastRunAt = finiteNumber(raw['lastRunAt'])
  const lastError = optionalString(raw['lastError'])
  const lastRunId = optionalString(raw['lastRunId'])
  const lastSessionId = optionalString(raw['lastSessionId'])
  const lastRunOutcome = asEnum(raw['lastRunOutcome'], TRIGGER_RUN_OUTCOMES)
  const lastRunVerdict = asEnum(raw['lastRunVerdict'], TRIGGER_VERDICT_KINDS)
  const lastRunSummaryRaw = raw['lastRunSummary']
  const lastRunSummary =
    typeof lastRunSummaryRaw === 'string' ? lastRunSummaryRaw.slice(0, 200) : undefined
  const lastRunCostUsd = finiteNumber(raw['lastRunCostUsd'])
  const lastRunDurationMs = finiteNumber(raw['lastRunDurationMs'])
  const activationConfirmed = optionalString(raw['activationConfirmed'])
  const sourceFingerprint = optionalString(raw['sourceFingerprint'])
  return {
    processed: normalizeProcessed(raw['processed']),
    paused: raw['paused'] === true,
    ...(raw['autoPaused'] === true ? { autoPaused: true } : {}),
    consecutiveFailures:
      consecutiveFailures === undefined ? 0 : Math.max(0, Math.floor(consecutiveFailures)),
    ...(backoffUntil === undefined ? {} : { backoffUntil }),
    ...(lastScheduledAt === undefined ? {} : { lastScheduledAt }),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastRunId === undefined ? {} : { lastRunId }),
    ...(lastSessionId === undefined ? {} : { lastSessionId }),
    ...(lastRunOutcome === undefined ? {} : { lastRunOutcome }),
    ...(lastRunVerdict === undefined ? {} : { lastRunVerdict }),
    ...(lastRunSummary === undefined ? {} : { lastRunSummary }),
    ...(lastRunCostUsd === undefined ? {} : { lastRunCostUsd }),
    ...(lastRunDurationMs === undefined ? {} : { lastRunDurationMs }),
    baselineDone: raw['baselineDone'] === true,
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    ...(activationConfirmed === undefined ? {} : { activationConfirmed }),
  }
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pending run ids become filesystem paths (`runs/<runId>`, `pending/<runId>.json`),
 * so a hand-edited or corrupted state file must not smuggle in separators / `..`.
 */
function sanitizeLoadedState(state: TriggerStateFile, logger: ILogger): TriggerStateFile {
  const pending = state.pending.filter((record) => {
    if (RUN_ID_PATTERN.test(record.runId)) return true
    logger.warn(`state.json: dropped a pending run with an invalid runId (${record.triggerKey})`)
    return false
  })
  if (pending.length === state.pending.length) return state
  return { ...state, pending }
}

function normalizePending(raw: unknown): PendingRunRecord[] {
  if (!Array.isArray(raw)) return []
  const pending: PendingRunRecord[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const runId = optionalString(entry['runId'])
    const triggerKey = optionalString(entry['triggerKey'])
    const eventKey = optionalString(entry['eventKey'])
    const firedAt = finiteNumber(entry['firedAt'])
    if (runId === undefined || triggerKey === undefined || eventKey === undefined) continue
    pending.push({ runId, triggerKey, eventKey, firedAt: firedAt ?? 0 })
  }
  return pending
}

/**
 * Version 1 keyed triggers by a local workspace path; workspace identity is now a
 * URI string, so an old snapshot cannot be reinterpreted. It is machine-local
 * dedupe / pause state — dropping it just re-seeds baselines.
 */
export function normalizeTriggerStateFile(raw: unknown): TriggerStateFile {
  if (!isRecord(raw) || raw['version'] !== 2) return createEmptyTriggerStateFile()
  const triggers: Record<string, TriggerRuntimeState> = {}
  if (isRecord(raw['triggers'])) {
    for (const [id, value] of Object.entries(raw['triggers'])) {
      triggers[id] = normalizeRuntimeState(value)
    }
  }
  return {
    version: 2,
    pausedAll: raw['pausedAll'] === true,
    triggers,
    pending: normalizePending(raw['pending']),
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
