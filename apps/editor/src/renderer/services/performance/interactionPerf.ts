/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Interaction-responsiveness pure logic: Event Timing samples are decomposed
 *  into input/processing/presentation delays, deduped per interaction id,
 *  aggregated into per-type histograms, and slow ones formatted into a single
 *  attributable log line (phases + LoAF scripts overlapping the window).
 *  No DOM access — the service feeds structured DTOs in.
 *--------------------------------------------------------------------------------------------*/

import { samplesInWindow, type PerfSample } from './perfPhases.js'

/** Structured snapshot of one Event Timing entry (PerformanceEventTiming). */
export interface InteractionEventSample {
  readonly eventType: string
  readonly startTime: number
  readonly processingStart: number
  readonly processingEnd: number
  readonly duration: number
  readonly interactionId: number
}

export interface InteractionDecomposition {
  readonly inputDelayMs: number
  readonly processingMs: number
  readonly presentationDelayMs: number
}

/** presentationDelay = duration − (processingEnd − startTime); duration is
 *  rounded to 8ms by the browser (anti-fingerprinting), so it can go negative. */
export function decomposeInteraction(sample: InteractionEventSample): InteractionDecomposition {
  const inputDelayMs = Math.max(0, sample.processingStart - sample.startTime)
  const processingMs = Math.max(0, sample.processingEnd - sample.processingStart)
  const presentationDelayMs = Math.max(
    0,
    sample.duration - (sample.processingEnd - sample.startTime),
  )
  return { inputDelayMs, processingMs, presentationDelayMs }
}

export interface DedupedInteraction {
  readonly kind: 'interaction' | 'non-interaction'
  readonly sample: InteractionEventSample
  /** Names of the events merged into this interaction (keydown+keypress+keyup…). */
  readonly eventTypes: readonly string[]
}

/** Entries sharing a non-zero interactionId are one user interaction (pointerdown
 *  + pointerup + click); keep the slowest. interactionId 0 marks non-interaction
 *  events (programmatic focus, pointerenter…) — kept on a separate channel. */
export function dedupeByInteraction(
  samples: readonly InteractionEventSample[],
): DedupedInteraction[] {
  const byId = new Map<number, { sample: InteractionEventSample; eventTypes: string[] }>()
  const nonInteraction: DedupedInteraction[] = []
  for (const sample of samples) {
    if (sample.interactionId === 0) {
      nonInteraction.push({ kind: 'non-interaction', sample, eventTypes: [sample.eventType] })
      continue
    }
    const existing = byId.get(sample.interactionId)
    if (!existing) {
      byId.set(sample.interactionId, { sample, eventTypes: [sample.eventType] })
    } else {
      existing.eventTypes.push(sample.eventType)
      if (sample.duration > existing.sample.duration) existing.sample = sample
    }
  }
  const interactions: DedupedInteraction[] = [...byId.values()].map(({ sample, eventTypes }) => ({
    kind: 'interaction',
    sample,
    eventTypes,
  }))
  return interactions.concat(nonInteraction)
}

/** HTML5 drag events always report interactionId 0, and their Event Timing
 *  duration spans to drag end: the native drag loop suppresses paint, so
 *  presentation delay is the drag's remaining time, not per-event jank
 *  (decomposition is ~0/0/N). Excluded from slow reporting — real main-thread
 *  stalls during a drag still surface via isUnattributedLongFrame. */
const DRAG_SESSION_EVENT_TYPES = new Set([
  'dragstart',
  'drag',
  'dragenter',
  'dragover',
  'dragleave',
  'drop',
  'dragend',
])

export function isDragSessionEvent(eventType: string): boolean {
  return DRAG_SESSION_EVENT_TYPES.has(eventType)
}

/** Histogram bucket upper bounds (ms); the last bucket catches everything above. */
export const HISTOGRAM_BUCKETS_MS = [16, 25, 50, 100, 200, 500, 1000] as const

export interface InteractionTypeStats {
  count: number
  maxMs: number
  /** Parallel to HISTOGRAM_BUCKETS_MS plus one overflow bucket. */
  readonly buckets: number[]
}

export function createTypeStats(): InteractionTypeStats {
  return { count: 0, maxMs: 0, buckets: new Array(HISTOGRAM_BUCKETS_MS.length + 1).fill(0) }
}

export function recordDuration(stats: InteractionTypeStats, durationMs: number): void {
  stats.count += 1
  if (durationMs > stats.maxMs) stats.maxMs = durationMs
  for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
    if (durationMs <= HISTOGRAM_BUCKETS_MS[i]!) {
      stats.buckets[i]! += 1
      return
    }
  }
  stats.buckets[HISTOGRAM_BUCKETS_MS.length]! += 1
}

/** Lower bound of the bucket a duration landed in (0 for the first bucket). */
function bucketLowerBound(index: number): number {
  return index === 0 ? 0 : HISTOGRAM_BUCKETS_MS[index - 1]!
}

/** Quantile estimate from a histogram, answered with the matching bucket's
 *  lower bound — honest resolution for ≥16ms-only samples. */
export function estimateQuantile(stats: InteractionTypeStats, q: number): number {
  if (stats.count === 0) return 0
  const target = Math.ceil(stats.count * q)
  let cumulative = 0
  for (let i = 0; i < stats.buckets.length; i++) {
    cumulative += stats.buckets[i]!
    if (cumulative >= target) return bucketLowerBound(i)
  }
  return HISTOGRAM_BUCKETS_MS[HISTOGRAM_BUCKETS_MS.length - 1]!
}

/** Scripts of a Long Animation Frame, reduced to the top offenders. */
export interface LoafScriptAttribution {
  readonly invoker: string
  readonly sourceUrl: string
  readonly sourceFunctionName: string
  readonly durationMs: number
}

export interface LoafSample {
  readonly startTime: number
  readonly duration: number
  readonly blockingDuration: number
  readonly scripts: readonly LoafScriptAttribution[]
}

const MAX_LOAF_URL_LENGTH = 80
const MAX_LOAF_SCRIPTS = 3

export function extractLoafScripts(
  scripts: readonly {
    invoker?: string
    sourceURL?: string
    sourceFunctionName?: string
    duration?: number
  }[],
): LoafScriptAttribution[] {
  return scripts
    .slice()
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, MAX_LOAF_SCRIPTS)
    .map((s) => {
      const url = s.sourceURL ?? ''
      return {
        invoker: s.invoker ?? '',
        sourceUrl: url.length > MAX_LOAF_URL_LENGTH ? url.slice(-MAX_LOAF_URL_LENGTH) : url,
        sourceFunctionName: s.sourceFunctionName ?? '',
        durationMs: s.duration ?? 0,
      }
    })
}

export interface SlowInteractionContext {
  /** e.g. `DIV._agentActions_x` / `BODY` — tagName plus id/testid marker. */
  readonly target: string
  /** e.g. `file:///a.ts (typescript, 1234 lines)`; empty when no file editor is active. */
  readonly editor: string
}

export interface SlowInteractionReport {
  readonly label: string
  readonly kind: 'interaction' | 'non-interaction'
  readonly eventTypes: readonly string[]
  readonly startTime: number
  readonly durationMs: number
  readonly decomposition: InteractionDecomposition
  readonly phases: readonly PerfSample[]
  readonly loafs: readonly LoafSample[]
  readonly context: SlowInteractionContext
}

export function buildSlowInteractionReport(input: {
  sample: InteractionEventSample
  kind: 'interaction' | 'non-interaction'
  eventTypes: readonly string[]
  phases: readonly PerfSample[]
  loafs: readonly LoafSample[]
  context: SlowInteractionContext
}): SlowInteractionReport {
  const { sample } = input
  const endTime = sample.startTime + sample.duration
  return {
    label: input.eventTypes[0] ?? sample.eventType,
    kind: input.kind,
    eventTypes: input.eventTypes,
    startTime: sample.startTime,
    durationMs: sample.duration,
    decomposition: decomposeInteraction(sample),
    phases: samplesInWindow(input.phases, sample.startTime, endTime),
    loafs: samplesInWindow(input.loafs, sample.startTime, endTime),
    context: input.context,
  }
}

function formatLoafScripts(loaf: LoafSample): string {
  return loaf.scripts.length > 0
    ? loaf.scripts
        .map(
          (s) =>
            `${s.sourceUrl || '<anonymous>'}${s.sourceFunctionName ? `#${s.sourceFunctionName}` : ''} (${s.invoker}) ${Math.round(s.durationMs)}ms`,
        )
        .join('; ')
    : '<no script attribution>'
}

function formatLoaf(loaf: LoafSample): string {
  return `frame ${Math.round(loaf.duration)}ms blocking ${Math.round(loaf.blockingDuration)}ms: ${formatLoafScripts(loaf)}`
}

/** One-line log format, aligned with formatTabSwitchReport:
 *  `slow keydown 312ms (input 8 / processing 96 / present 208) target=… editor=… phases: […] loaf: […]` */
export function formatSlowInteractionLine(report: SlowInteractionReport): string {
  const ms = (n: number): string => `${Math.round(n)}`
  const d = report.decomposition
  const slow = report.kind === 'interaction' ? 'slow' : 'slow (non-interaction)'
  const events = report.eventTypes.length > 1 ? ` events=[${report.eventTypes.join('+')}]` : ''
  const phases =
    report.phases.length > 0
      ? ` phases: [${report.phases
          .map(
            (p) =>
              `${p.name} ${ms(p.duration)}ms @+${Math.round(p.startTime - report.startTime)}ms`,
          )
          .join(', ')}]`
      : ''
  const loaf = report.loafs.length > 0 ? ` loaf: [${report.loafs.map(formatLoaf).join(' | ')}]` : ''
  const editor = report.context.editor ? ` editor=${report.context.editor}` : ''
  return (
    `${slow} ${report.label} ${ms(report.durationMs)}ms ` +
    `(input ${ms(d.inputDelayMs)} / processing ${ms(d.processingMs)} / present ${ms(d.presentationDelayMs)})` +
    `${events} target=${report.context.target}${editor}${phases}${loaf}`
  )
}

/** A LoAF overlapping no observed interaction — the main thread froze without
 *  any Event Timing interaction around (scrolling, dragging, background work). */
export function isUnattributedLongFrame(
  loaf: LoafSample,
  interactions: readonly { readonly startTime: number; readonly duration: number }[],
  warnThresholdMs: number,
): boolean {
  if (loaf.blockingDuration < warnThresholdMs) return false
  return samplesInWindow(interactions, loaf.startTime, loaf.startTime + loaf.duration).length === 0
}

export function formatLongFrameLine(loaf: LoafSample): string {
  return `long frame ${Math.round(loaf.duration)}ms blocking ${Math.round(loaf.blockingDuration)}ms (no interaction) scripts: ${formatLoafScripts(loaf)}`
}

/** Per-key warn throttle: one warn per window; suppressed counts fold into the
 *  next allowed warn so sustained jank cannot flood the log. */
export class WarnThrottle {
  private readonly _windows = new Map<string, { windowStart: number; suppressed: number }>()

  constructor(
    private readonly _windowMs: number = 1000,
    private readonly _now: () => number = () => performance.now(),
  ) {}

  /** Returns the number of suppressed warns folded into this one, or undefined
   *  when this warn is throttled away. */
  tryWarn(key: string): number | undefined {
    const now = this._now()
    const entry = this._windows.get(key)
    if (!entry || now - entry.windowStart >= this._windowMs) {
      const suppressed = entry?.suppressed ?? 0
      this._windows.set(key, { windowStart: now, suppressed: 0 })
      return suppressed
    }
    entry.suppressed += 1
    return undefined
  }

  reset(): void {
    this._windows.clear()
  }
}

export function formatSuppressedSuffix(suppressed: number, key: string): string {
  return suppressed > 0 ? ` (suppressed ${suppressed} more slow ${key})` : ''
}
