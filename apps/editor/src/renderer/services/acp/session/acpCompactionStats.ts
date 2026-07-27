/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpCompactionStatsService — durable, per-agent history of how long context
 *  compaction actually takes on this machine, so the CompactionCard's progress
 *  estimate is grounded in observed timing instead of a fixed constant.
 *
 *  The SDK compaction is an atomic summarization call with no real progress
 *  signal. Before we had samples the card eased toward 100% off a hard-coded
 *  time constant; here we record the real `durationMs` of every successful
 *  compaction (bucketed by agentId, since timing tracks the agent/model, not a
 *  specific session) and expose the median as the expected duration for the
 *  next run. Failed compactions are ignored — an aborted summarization has no
 *  bearing on how long a real one takes.
 *
 *  Storage mirrors AcpChatLocationService: single GLOBAL bucket via
 *  IStorageService, debounced writes, synchronous flush on dispose.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  ILoggerService,
  InstantiationType,
  IStorageService,
  ITelemetryService,
  registerSingleton,
  StorageScope,
  type ILogger,
} from '@universe-editor/platform'

export interface IAcpCompactionStatsService {
  readonly _serviceBrand: undefined
  /** Idempotent. main.tsx fire-and-forgets at startup. */
  initialize(): Promise<void>
  /** Record the wall-clock duration (ms) of a successful compaction for `agentId`. */
  record(agentId: string, durationMs: number): void
  /**
   * Expected duration (ms) of the next compaction for `agentId`, derived as the
   * median of recorded samples. `undefined` when no samples exist yet, so the
   * card can fall back to its constant-based estimate.
   */
  getExpectedDurationMs(agentId: string): number | undefined
}

export const IAcpCompactionStatsService = createDecorator<IAcpCompactionStatsService>(
  'acpCompactionStatsService',
)

const STORAGE_KEY = 'acp.compactionStats'
const SCHEMA_VERSION = 1
/** Keep the most recent N samples per agent; a rolling window tracks drift (model swaps, machine load). */
const MAX_SAMPLES = 20

interface PersistedShape {
  readonly schemaVersion: number
  /** agentId → recent successful compaction durations (ms), oldest first. */
  readonly samples: Readonly<Record<string, readonly number[]>>
}

export class AcpCompactionStatsService extends Disposable implements IAcpCompactionStatsService {
  declare readonly _serviceBrand: undefined

  private _samples = new Map<string, number[]>()
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _logger: ILogger

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acpCompactionStats',
      name: 'ACP Compaction Stats',
    })
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  record(agentId: string, durationMs: number): void {
    if (!agentId || !Number.isFinite(durationMs) || durationMs <= 0) return
    const arr = this._samples.get(agentId) ?? []
    arr.push(Math.round(durationMs))
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES)
    this._samples.set(agentId, arr)
    this._scheduleWrite()
  }

  getExpectedDurationMs(agentId: string): number | undefined {
    const arr = this._samples.get(agentId)
    if (!arr || arr.length === 0) return undefined
    return median(arr)
  }

  override dispose(): void {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = undefined
      void this._writeNow()
    }
    super.dispose()
  }

  // -- internals ---------------------------------------------------------

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (
        raw &&
        typeof raw === 'object' &&
        raw.schemaVersion === SCHEMA_VERSION &&
        raw.samples &&
        typeof raw.samples === 'object'
      ) {
        for (const [agentId, values] of Object.entries(raw.samples)) {
          if (!Array.isArray(values)) continue
          const clean = values.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n))
          if (clean.length > 0) this._samples.set(agentId, clean.slice(-MAX_SAMPLES))
        }
      } else if (raw !== undefined) {
        this._logger.warn(
          `ignoring acp.compactionStats with schemaVersion=${(raw as PersistedShape).schemaVersion}`,
        )
      }
    } catch (err) {
      this._logger.warn(`failed to load compaction stats: ${(err as Error).message}`)
    } finally {
      this._loaded = true
    }
  }

  private _scheduleWrite(): void {
    if (this._writeTimer) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined
      void this._writeNow()
    }, 100)
  }

  private async _writeNow(): Promise<void> {
    try {
      const samples: Record<string, readonly number[]> = {}
      for (const [agentId, arr] of this._samples) samples[agentId] = [...arr]
      const payload: PersistedShape = { schemaVersion: SCHEMA_VERSION, samples }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.compaction_stats_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`failed to persist compaction stats: ${(err as Error).message}`)
    }
  }
}

/** Median of a non-empty numeric array; even length averages the two middle samples. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]!
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

registerSingleton(IAcpCompactionStatsService, AcpCompactionStatsService, InstantiationType.Delayed)
