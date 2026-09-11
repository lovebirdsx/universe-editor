/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer memory watermark: observes the renderer's own V8 heap and orchestrates
 *  release of the caches that hold the most.
 *
 *  Why this exists: the crash that motivated it built ~3.8GB of live `lo_space` (large
 *  strings held by renderer caches) with nothing in the process watching. GC reclaimed
 *  0.0MB on the way down, so every byte was reachable, and the log went silent for the
 *  last 20-40s because the sampling that did exist lived in the main process and could
 *  not see the renderer's heap at all. This service is the missing observer, and the
 *  release it drives is what turns "the app dies" into "old content is dropped".
 *
 *  Scope: observation + orchestration only. It holds no cache of its own — every cache
 *  that can give memory back registers a releaser, which keeps the policy here and the
 *  data where it belongs.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  ILoggerService,
  createDecorator,
  createNamedLogger,
  observableValue,
  toDisposable,
  type Event,
  type IDisposable,
  type ILogger,
  type IObservable,
  type ITelemetryService,
} from '@universe-editor/platform'
import {
  MemoryPressureLevel,
  MEMORY_PRESSURE_LEVEL_NAMES,
  evaluatePressure,
  resolveMemoryThresholds,
  type MemorySample,
  type MemoryThresholds,
} from './memoryPressureLevels.js'
import { readHeapSample } from './rendererHeapSample.js'

/** One cache that can hand memory back. */
export interface IMemoryReleaser {
  /** Stable id — attribution logs name it, so keep it recognisable. */
  readonly id: string
  /** Lower runs first. Ties keep registration order. */
  readonly priority?: number
  /**
   * Drop cache content and return the bytes actually released. The number is the
   * whole point: a releaser that reports nothing cannot be told apart from one that
   * freed nothing, and the attribution log becomes unreadable.
   */
  release(level: MemoryPressureLevel): number
}

export interface MemoryReleaseReport {
  readonly id: string
  readonly freed: number
  /** Present when the releaser threw — one failure must not stop the others. */
  readonly error?: string
}

export interface MemoryPressureSample {
  readonly level: MemoryPressureLevel
  readonly previous: MemoryPressureLevel
  readonly used: number
  readonly limit: number
  readonly thresholds: MemoryThresholds
}

export interface IMemoryPressureService {
  readonly _serviceBrand: undefined
  readonly level: IObservable<MemoryPressureLevel>
  readonly onDidChangeLevel: Event<MemoryPressureLevel>
  readonly onDidSample: Event<MemoryPressureSample>
  /** Register a cache. Disposing the returned handle unregisters it. */
  registerReleaser(releaser: IMemoryReleaser): IDisposable
  /** Read the heap, re-evaluate, and release if a line was crossed. */
  sample(): MemoryPressureLevel
  /** Run every releaser at `level`, lowest priority first. */
  release(level: MemoryPressureLevel): readonly MemoryReleaseReport[]
  /** True once the heap is at or past the elevated line. Cheap; safe to poll. */
  isConstrained(): boolean
  /** Ids of the registered caches, registration order — for diagnostics and specs. */
  releaserIds(): readonly string[]
  /** One-line summary for logs and diagnostics bundles. */
  describe(): string
  start(): void
  stop(): void
}

export const IMemoryPressureService =
  createDecorator<IMemoryPressureService>('memoryPressureService')

/**
 * Sampling cadence. Deliberately not `requestIdleCallback`: this is the signal you want
 * *while* the main thread is being squeezed by GC, and an idle callback never fires in
 * that state — the observed crash went silent for 20-40s for exactly that reason. A
 * self-rescheduling `setTimeout` keeps running through it.
 */
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000
/** Tighter cadence once a line is crossed, so the ramp is visible before it is fatal. */
export const MEMORY_SAMPLE_INTERVAL_PRESSURED_MS = 1_000

export interface MemoryPressureServiceOptions {
  readonly readSample?: () => MemorySample | undefined
  /** Test seam: the clock behind the cadence. */
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class MemoryPressureService extends Disposable implements IMemoryPressureService {
  declare readonly _serviceBrand: undefined

  private readonly _level = observableValue<MemoryPressureLevel>(
    'memoryPressureLevel',
    MemoryPressureLevel.Normal,
  )
  private readonly _onDidChangeLevel = this._register(
    // A listener that throws must not take the sampler (and with it the only
    // observer of the heap) down with it.
    new Emitter<MemoryPressureLevel>({ onListenerError: () => {} }),
  )
  private readonly _onDidSample = this._register(
    new Emitter<MemoryPressureSample>({ onListenerError: () => {} }),
  )
  readonly level: IObservable<MemoryPressureLevel> = this._level
  readonly onDidChangeLevel: Event<MemoryPressureLevel> = this._onDidChangeLevel.event
  readonly onDidSample: Event<MemoryPressureSample> = this._onDidSample.event

  private readonly _releasers: { releaser: IMemoryReleaser; order: number }[] = []
  private readonly _logger: ILogger
  private readonly _readSample: () => MemorySample | undefined
  private readonly _setTimer: (run: () => void, ms: number) => unknown
  private readonly _clearTimer: (handle: unknown) => void

  private _order = 0
  // Seeded from the assumed cage, then replaced by the process's real limit on the
  // first sample that reports one. Deriving it per evaluation instead would let a
  // transient 0 flip the thresholds and flap the level.
  private _thresholds: MemoryThresholds = resolveMemoryThresholds(0)
  private _lastUsed = 0
  private _lastLimit = 0
  private _timer: unknown
  private _running = false
  private _releasing = false

  constructor(
    loggerService: ILoggerService,
    private readonly _telemetry: ITelemetryService,
    options: MemoryPressureServiceOptions = {},
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'memory', name: 'Memory' })
    this._readSample = options.readSample ?? readHeapSample
    this._setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms) as unknown)
    this._clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
  }

  registerReleaser(releaser: IMemoryReleaser): IDisposable {
    const entry = { releaser, order: this._order++ }
    this._releasers.push(entry)
    return toDisposable(() => {
      const idx = this._releasers.indexOf(entry)
      if (idx !== -1) this._releasers.splice(idx, 1)
    })
  }

  isConstrained(): boolean {
    return this._level.get() !== MemoryPressureLevel.Normal
  }

  releaserIds(): readonly string[] {
    return this._releasers.map((entry) => entry.releaser.id)
  }

  describe(): string {
    const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
    return (
      `memory ${MEMORY_PRESSURE_LEVEL_NAMES[this._level.get()]} ` +
      `used=${mb(this._lastUsed)}MB limit=${mb(this._lastLimit)}MB ` +
      `elevated=${mb(this._thresholds.elevated)}MB critical=${mb(this._thresholds.critical)}MB ` +
      `releasers=${this._releasers.length}`
    )
  }

  start(): void {
    if (this._running) return
    this._running = true
    this._schedule()
  }

  stop(): void {
    this._running = false
    if (this._timer !== undefined) {
      this._clearTimer(this._timer)
      this._timer = undefined
    }
  }

  sample(): MemoryPressureLevel {
    const sample = this._readSample()
    if (!sample) {
      // No observation available. Stay where we are rather than assuming health:
      // reporting `normal` here would let a blind process look calm.
      return this._level.get()
    }
    this._lastUsed = sample.used
    this._lastLimit = sample.limit
    if (sample.limit > 0) this._thresholds = resolveMemoryThresholds(sample.limit)

    const previous = this._level.get()
    const next = evaluatePressure(sample, previous, this._thresholds)
    this._onDidSample.fire({
      level: next,
      previous,
      used: sample.used,
      limit: sample.limit,
      thresholds: this._thresholds,
    })
    if (next === previous) return next

    this._level.set(next, undefined)
    this._onDidChangeLevel.fire(next)
    if (next !== MemoryPressureLevel.Normal) {
      // Snapshot before releasing: the pre-release state is the one worth having,
      // because that is the state the process was actually in when it went bad.
      this._snapshot(next, sample)
      this.release(next)
    }
    return next
  }

  release(level: MemoryPressureLevel): readonly MemoryReleaseReport[] {
    // Re-entrancy guard: releasing drops observable content, and a subscriber that
    // reacts by touching a cache could otherwise re-enter this.
    if (this._releasing) return []
    this._releasing = true
    const reports: MemoryReleaseReport[] = []
    try {
      const ordered = [...this._releasers].sort(
        (a, b) => (a.releaser.priority ?? 0) - (b.releaser.priority ?? 0) || a.order - b.order,
      )
      for (const { releaser } of ordered) {
        try {
          const freed = releaser.release(level)
          // A releaser that reports a number it cannot stand behind makes the
          // attribution log unreadable — the one thing it exists for. Negative and
          // non-finite values are rejected loudly rather than folded into the total.
          if (!Number.isFinite(freed) || freed < 0) {
            const message = `releaser reported a non-finite release: ${freed}`
            reports.push({ id: releaser.id, freed: 0, error: message })
            this._logger.warn(`[memory] ${releaser.id} ${message}`)
            continue
          }
          if (freed > 0) reports.push({ id: releaser.id, freed })
        } catch (err) {
          // One bad releaser must not cost the others their turn — under memory
          // pressure the whole point is to release as much as possible.
          const message = err instanceof Error ? err.message : String(err)
          reports.push({ id: releaser.id, freed: 0, error: message })
          this._logger.warn(`[memory] releaser ${releaser.id} failed: ${message}`)
        }
      }
    } finally {
      this._releasing = false
    }
    if (reports.length > 0) {
      const total = reports.reduce((sum, r) => sum + r.freed, 0)
      const detail = reports
        .map((r) => `${r.id}=${Math.round(r.freed / 1024)}KiB${r.error ? '(failed)' : ''}`)
        .join(' ')
      this._logger.info(
        `[memory] released ${Math.round(total / 1024)}KiB at ${MEMORY_PRESSURE_LEVEL_NAMES[level]}: ${detail}`,
      )
    }
    return reports
  }

  private _schedule(): void {
    if (!this._running) return
    const interval = this.isConstrained()
      ? MEMORY_SAMPLE_INTERVAL_PRESSURED_MS
      : MEMORY_SAMPLE_INTERVAL_MS
    this._timer = this._setTimer(() => {
      this._timer = undefined
      this.sample()
      this._schedule()
    }, interval)
  }

  private _snapshot(level: MemoryPressureLevel, sample: MemorySample): void {
    const pct = sample.limit > 0 ? ((sample.used / sample.limit) * 100).toFixed(1) : '?'
    this._logger.warn(
      `[memory] ${MEMORY_PRESSURE_LEVEL_NAMES[level]} at ${pct}% — ${this.describe()}`,
    )
    this._telemetry.publicLogError('memoryPressure', {
      level: MEMORY_PRESSURE_LEVEL_NAMES[level],
      usedMb: Math.round(sample.used / (1024 * 1024)),
      limitMb: Math.round(sample.limit / (1024 * 1024)),
    })
  }

  override dispose(): void {
    this.stop()
    this._releasers.length = 0
    super.dispose()
  }
}
