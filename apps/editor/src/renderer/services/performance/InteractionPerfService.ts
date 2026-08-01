/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  InteractionPerfService — always-on responsiveness floor. Two passive
 *  PerformanceObservers cover the jank spectrum: Event Timing entries (every
 *  discrete interaction ≥16ms) are aggregated into per-type histograms, and
 *  any interaction past the warn threshold gets a single attributable log
 *  line (input/processing/presentation split, recorded perf phases and LoAF
 *  script attribution overlapping its window, O(1) context snapshot).
 *  Aggregation lives in memory only; the disk sees slow interactions and the
 *  session summary. Observers degrade silently where unsupported (tests).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorService,
  ILoggerService,
  createDecorator,
  createNamedLogger,
  type Event,
  Emitter,
  type ILogger,
} from '@universe-editor/platform'
import { getRecordedPhases } from './perfPhases.js'
import {
  WarnThrottle,
  buildSlowInteractionReport,
  createTypeStats,
  dedupeByInteraction,
  estimateQuantile,
  extractLoafScripts,
  formatLongFrameLine,
  formatSlowInteractionLine,
  formatSuppressedSuffix,
  isUnattributedLongFrame,
  recordDuration,
  type InteractionEventSample,
  type InteractionTypeStats,
  type LoafSample,
  type SlowInteractionContext,
  type SlowInteractionReport,
} from './interactionPerf.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'

export const IInteractionPerfService =
  createDecorator<IInteractionPerfService>('interactionPerfService')

export interface SlowestInteractionEntry {
  readonly label: string
  readonly durationMs: number
  readonly startTime: number
  readonly report: SlowInteractionReport
}

export interface InteractionPerfSummary {
  readonly startedAt: number | undefined
  readonly totalSampleCount: number
  readonly interactionCount: number
  readonly slowCount: number
  readonly byType: Readonly<
    Record<string, { count: number; maxMs: number; p95Ms: number; p99Ms: number }>
  >
  readonly slowest: readonly SlowestInteractionEntry[]
  readonly loafCount: number
}

export interface IInteractionPerfService {
  readonly _serviceBrand: undefined
  readonly onDidRecordSlowInteraction: Event<SlowInteractionReport>
  start(options: { warnThresholdMs: number }): void
  stop(): void
  getSummary(): InteractionPerfSummary
}

const MAX_SLOW_REPORTS = 128
const MAX_SLOWEST_ENTRIES = 20
const MAX_LOAF_SAMPLES = 64
const EVENT_OBSERVE_THRESHOLD_MS = 16
const MAX_TARGET_LENGTH = 64

export class InteractionPerfService extends Disposable implements IInteractionPerfService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _onDidRecordSlowInteraction = this._register(
    new Emitter<SlowInteractionReport>(),
  )
  readonly onDidRecordSlowInteraction = this._onDidRecordSlowInteraction.event

  private _eventObserver: PerformanceObserver | undefined
  private _loafObserver: PerformanceObserver | undefined
  private _warnThresholdMs = 200
  private _startedAt: number | undefined

  private _totalSampleCount = 0
  private _interactionCount = 0
  private _slowCount = 0
  private readonly _byType = new Map<string, InteractionTypeStats>()
  private readonly _slowReports: SlowInteractionReport[] = []
  private readonly _slowest: SlowestInteractionEntry[] = []
  private readonly _loafSamples: LoafSample[] = []
  private _loafCount = 0
  private readonly _throttle = new WarnThrottle()

  constructor(
    @ILoggerService loggerService: ILoggerService,
    @IEditorService private readonly _editorService: IEditorService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'interactionPerf',
      name: 'Interaction Performance',
    })
    this._register({ dispose: () => this._teardownObservers() })
    this._register({ dispose: () => this._logSessionSummary() })
  }

  start(options: { warnThresholdMs: number }): void {
    this._warnThresholdMs = options.warnThresholdMs
    this._startedAt ??= Date.now()
    this._observeEventTiming()
    this._observeLongAnimationFrames()
  }

  stop(): void {
    this._teardownObservers()
    this._logSessionSummary()
    this._startedAt = undefined
  }

  getSummary(): InteractionPerfSummary {
    const byType: Record<string, { count: number; maxMs: number; p95Ms: number; p99Ms: number }> =
      {}
    for (const [type, stats] of this._byType) {
      byType[type] = {
        count: stats.count,
        maxMs: stats.maxMs,
        p95Ms: estimateQuantile(stats, 0.95),
        p99Ms: estimateQuantile(stats, 0.99),
      }
    }
    return {
      startedAt: this._startedAt,
      totalSampleCount: this._totalSampleCount,
      interactionCount: this._interactionCount,
      slowCount: this._slowCount,
      byType,
      slowest: [...this._slowest].sort((a, b) => b.durationMs - a.durationMs),
      loafCount: this._loafCount,
    }
  }

  private _teardownObservers(): void {
    this._eventObserver?.disconnect()
    this._eventObserver = undefined
    this._loafObserver?.disconnect()
    this._loafObserver = undefined
  }

  private _observeEventTiming(): void {
    if (this._eventObserver || typeof PerformanceObserver === 'undefined') return
    try {
      const observer = new PerformanceObserver((entries) => {
        this._handleEventEntries(
          entries.getEntries() as unknown as readonly (InteractionEventSample & {
            name: string
            target: EventTarget | null
          })[],
        )
      })
      observer.observe({
        type: 'event',
        durationThreshold: EVENT_OBSERVE_THRESHOLD_MS,
        buffered: true,
      } as PerformanceObserverInit)
      this._eventObserver = observer
    } catch {
      // No Event Timing support (tests / old engines) — the floor simply stays
      // dark; the tab-switch watchdog and longtask window still cover jank.
    }
  }

  private _observeLongAnimationFrames(): void {
    if (this._loafObserver || typeof PerformanceObserver === 'undefined') return
    try {
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          const e = entry as PerformanceEntry & {
            duration: number
            blockingDuration?: number
            scripts?: readonly {
              invoker?: string
              sourceURL?: string
              sourceFunctionName?: string
              duration?: number
            }[]
          }
          this._handleLoafEntry({
            startTime: e.startTime,
            duration: e.duration,
            blockingDuration: e.blockingDuration ?? 0,
            scripts: extractLoafScripts(e.scripts ?? []),
          })
        }
      })
      observer.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
      this._loafObserver = observer
    } catch {
      // No LoAF support — slow interactions just lack script attribution.
    }
  }

  /** Exported for tests: the observer callback feeds real entries here. */
  _handleEventEntries(
    entries: readonly (InteractionEventSample & { target: EventTarget | null })[],
  ): void {
    const deduped = dedupeByInteraction(entries)
    for (const item of deduped) {
      const { sample } = item
      this._totalSampleCount += 1
      if (item.kind === 'interaction') {
        this._interactionCount += 1
        let stats = this._byType.get(sample.eventType)
        if (!stats) {
          stats = createTypeStats()
          this._byType.set(sample.eventType, stats)
        }
        recordDuration(stats, sample.duration)
      }
      if (sample.duration >= this._warnThresholdMs) {
        this._reportSlowInteraction(item.kind, sample, item.eventTypes, entries)
      }
    }
  }

  private _reportSlowInteraction(
    kind: 'interaction' | 'non-interaction',
    sample: InteractionEventSample,
    eventTypes: readonly string[],
    allEntries: readonly (InteractionEventSample & { target: EventTarget | null })[],
  ): void {
    this._slowCount += 1
    const throttleKey = `${kind}:${sample.eventType}`
    const suppressed = this._throttle.tryWarn(throttleKey)
    const report = buildSlowInteractionReport({
      sample,
      kind,
      eventTypes,
      phases: getRecordedPhases(),
      loafs: this._loafSamples,
      context: this._snapshotContext(allEntries),
    })
    this._slowReports.push(report)
    if (this._slowReports.length > MAX_SLOW_REPORTS) {
      this._slowReports.splice(0, this._slowReports.length - MAX_SLOW_REPORTS)
    }
    this._recordSlowest(report)
    this._onDidRecordSlowInteraction.fire(report)
    if (suppressed === undefined) return
    this._logger.warn(
      formatSlowInteractionLine(report) + formatSuppressedSuffix(suppressed, sample.eventType),
    )
  }

  private _recordSlowest(report: SlowInteractionReport): void {
    this._slowest.push({
      label: report.label,
      durationMs: report.durationMs,
      startTime: report.startTime,
      report,
    })
    this._slowest.sort((a, b) => b.durationMs - a.durationMs)
    if (this._slowest.length > MAX_SLOWEST_ENTRIES) this._slowest.length = MAX_SLOWEST_ENTRIES
  }

  /** Exported for tests. */
  _handleLoafEntry(loaf: LoafSample): void {
    this._loafCount += 1
    this._loafSamples.push(loaf)
    if (this._loafSamples.length > MAX_LOAF_SAMPLES) {
      this._loafSamples.splice(0, this._loafSamples.length - MAX_LOAF_SAMPLES)
    }
    if (isUnattributedLongFrame(loaf, this._recentSlowWindows(), this._warnThresholdMs)) {
      const suppressed = this._throttle.tryWarn('longframe')
      if (suppressed !== undefined) {
        this._logger.warn(formatLongFrameLine(loaf) + formatSuppressedSuffix(suppressed, 'frame'))
      }
    }
  }

  private _recentSlowWindows(): readonly { startTime: number; duration: number }[] {
    return this._slowReports.map((r) => ({ startTime: r.startTime, duration: r.durationMs }))
  }

  private _snapshotContext(
    entries: readonly (InteractionEventSample & { target: EventTarget | null })[],
  ): SlowInteractionContext {
    return {
      target: describeTarget(firstLiveTarget(entries)),
      editor: describeActiveEditor(this._editorService),
    }
  }

  private _logSessionSummary(): void {
    if (this._totalSampleCount === 0) return
    const parts: string[] = []
    for (const [type, stats] of this._byType) {
      parts.push(`${type}: n=${stats.count} p95=${Math.round(estimateQuantile(stats, 0.95))}ms`)
    }
    this._logger.info(
      `session: ${this._interactionCount} interactions (${this._totalSampleCount} samples ≥${EVENT_OBSERVE_THRESHOLD_MS}ms), ` +
        `${this._slowCount} slow, ${this._loafCount} long frames${parts.length > 0 ? ' — ' + parts.join(', ') : ''}`,
    )
  }
}

function firstLiveTarget(
  entries: readonly (InteractionEventSample & { target: EventTarget | null })[],
): EventTarget | null {
  for (const entry of entries) {
    if (entry.target) return entry.target
  }
  return null
}

function describeTarget(target: EventTarget | null): string {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return '<none>'
  const marker = target.getAttribute('data-testid') ?? (target.id ? `#${target.id}` : '')
  const raw = `${target.tagName.toLowerCase()}${marker}`
  return raw.length > MAX_TARGET_LENGTH ? raw.slice(0, MAX_TARGET_LENGTH) : raw
}

function describeActiveEditor(editorService: IEditorService): string {
  const input = editorService.activeEditor.get()
  if (!(input instanceof FileEditorInput)) return ''
  const editor = FileEditorRegistry.get(input)
  const lineCount = editor?.getModel()?.getLineCount()
  return (
    `${input.resource.toString()} (${input.language}` +
    `${lineCount !== undefined ? `, ${lineCount} lines` : ''})`
  )
}
