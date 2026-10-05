/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpCompactionStatsService — durable history of how long context compaction
 *  actually takes on this machine, so the CompactionCard's progress estimate is
 *  grounded in observed timing instead of a fixed constant.
 *
 *  The SDK compaction is an atomic summarization call with no real progress
 *  signal. Before we had samples the card eased toward 100% off a hard-coded
 *  time constant; here we record the real `durationMs` of every successful
 *  compaction and expose the median as the expected duration for the next run.
 *  Failed compactions are ignored — an aborted summarization has no bearing on
 *  how long a real one takes.
 *
 *  Samples are bucketed by agent AND model: duration tracks the model (a 1M-lane
 *  compaction summarizes ~5x the tokens of a bare 200k one), so a single
 *  per-agent median mis-paces the card the moment the user switches model rows.
 *  A lookup falls back to the bare-agent bucket — the model-unknown samples —
 *  only while the model's own bucket is empty. That fallback is a bridge, never
 *  a pool: folding another model's samples into an unsampled one is exactly the
 *  skew this split removes, so a known model's sample goes to its own bucket and
 *  never to the bare one.
 *
 *  Known limitation: the bucket ignores the connection authority, so a
 *  remote-host compaction shares the local model's timing.
 *
 *  Storage mirrors AcpSessionFilterService: single GLOBAL bucket via
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
import { normalizeAnthropicVersionDots } from '../../../../shared/ai/catalog/index.js'

export interface IAcpCompactionStatsService {
  readonly _serviceBrand: undefined
  /** Idempotent. main.tsx fire-and-forgets at startup. */
  initialize(): Promise<void>
  /**
   * Record the wall-clock duration (ms) of a successful compaction for `agentId`
   * under `modelId`. A known model writes only to its own bucket; `undefined`
   * (the model was unknown) writes to the agent-wide bucket.
   */
  record(agentId: string, durationMs: number, modelId: string | undefined): void
  /**
   * Expected duration (ms) of the next compaction for `agentId` under `modelId`,
   * derived as the median of recorded samples: the model's own bucket once it has
   * samples, otherwise the model-unknown bucket as a cold-start bridge.
   * `undefined` when neither exists, so the card falls back to its constant.
   */
  getExpectedDurationMs(agentId: string, modelId: string | undefined): number | undefined
}

export const IAcpCompactionStatsService = createDecorator<IAcpCompactionStatsService>(
  'acpCompactionStatsService',
)

const STORAGE_KEY = 'acp.compactionStats'
/**
 * Deliberately still 1: the persisted shape (`Record<string, number[]>`) is
 * unchanged, only the key space widens. v1's bare-agentId keys are exactly the
 * model-unknown bucket, so old samples stay meaningful as the cold-start bridge
 * instead of being dropped for a version bump that buys nothing.
 */
const SCHEMA_VERSION = 1
/** Keep the most recent N samples per bucket; a rolling window tracks drift (model swaps, machine load). */
const MAX_SAMPLES = 20
/** Bucket-key separator. `\0` cannot occur in an agent id or a model id. */
const KEY_SEP = '\0'

interface PersistedShape {
  readonly schemaVersion: number
  /**
   * bucketKey → recent successful compaction durations (ms), oldest first. A key
   * is `${agentId}\0${modelId}` for a known model, or a bare `agentId` for the
   * model-unknown bucket. Keys are opaque to the loader — never parsed back —
   * which is what lets one flat record cover both shapes.
   */
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

  record(agentId: string, durationMs: number, modelId: string | undefined): void {
    if (!agentId || !Number.isFinite(durationMs) || durationMs <= 0) return
    const key = bucketKey(agentId, modelId)
    const arr = this._samples.get(key) ?? []
    arr.push(Math.round(durationMs))
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES)
    this._samples.set(key, arr)
    this._logger.debug(`recorded ${Math.round(durationMs)}ms under "${key}" (n=${arr.length})`)
    this._scheduleWrite()
  }

  getExpectedDurationMs(agentId: string, modelId: string | undefined): number | undefined {
    const key = bucketKey(agentId, modelId)
    const exact = this._samples.get(key)
    if (exact && exact.length > 0) return median(exact)
    // Cold start for this model: bridge with the model-unknown samples rather
    // than dropping straight to the card's fixed constant. Short lived — the
    // model's own bucket takes over from its first recorded sample. Only ever
    // reads the bare-agent bucket, so a second model's samples can never leak in.
    const bridge = key === agentId ? undefined : this._samples.get(agentId)
    if (bridge && bridge.length > 0) {
      this._logger.debug(`no samples under "${key}"; bridging from "${agentId}"`)
      return median(bridge)
    }
    return undefined
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

/**
 * Bucket key for one agent + model. An `undefined` model — or an id that
 * normalizes to empty — means "unknown", which lands in the bare-agent bucket.
 */
function bucketKey(agentId: string, modelId: string | undefined): string {
  const model = modelId === undefined ? '' : normalizeModelKey(modelId)
  return model === '' ? agentId : `${agentId}${KEY_SEP}${model}`
}

/**
 * Fold the spellings one model can arrive under into a single key. Version dots
 * are the known divergence (a gateway declares `claude-opus-4.8` while Anthropic
 * spells `claude-opus-4-8`). The lane suffix is deliberately kept: `[1m]` is a
 * different compaction workload, not a spelling variant, so it must not fold
 * into the bare model's bucket. Dated snapshots and aliases
 * (`claude-opus-4-8-20260101` vs `claude-opus-4-8`) do stay split — the cheaper
 * mistake, since a split only costs a cold-start bridge while folding could mix
 * two genuinely different workloads.
 */
function normalizeModelKey(modelId: string): string {
  return normalizeAnthropicVersionDots(modelId.trim().toLowerCase())
}

/** Median of a non-empty numeric array; even length averages the two middle samples. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]!
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

registerSingleton(IAcpCompactionStatsService, AcpCompactionStatsService, InstantiationType.Delayed)
