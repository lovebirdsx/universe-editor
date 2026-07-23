/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Tab-switch jank instrumentation. Reactions known to run on the active-editor
 *  change path record themselves as named phases via `recordTabSwitchPhase`;
 *  TabSwitchPerfContribution correlates those phases with `longtask` entries
 *  inside each switch's observation window and logs a warning when the main
 *  thread was blocked past the threshold — so a slow switch in the wild leaves
 *  an attributable trace in the window log instead of an unexplained freeze.
 *--------------------------------------------------------------------------------------------*/

export interface TabSwitchSample {
  readonly name: string
  /** performance.now() timebase. */
  readonly startTime: number
  readonly duration: number
}

/** A switch is logged as a warning past this much freeze / main-thread blockage. */
export const TAB_SWITCH_WARN_MS = 200

/** Deferred reactions (200ms throttled re-diffs / re-scans, async providers)
 *  land well after the switch itself but still belong to it. */
export const TAB_SWITCH_OBSERVE_WINDOW_MS = 1500

/** Phases shorter than this are healthy noise — dropped from reports. */
const MIN_REPORTED_PHASE_MS = 1

const MAX_PHASE_SAMPLES = 256
const phaseSamples: TabSwitchSample[] = []

/** Run `fn`, recording its wall time under `name` for tab-switch reports. */
export function recordTabSwitchPhase<T>(name: string, fn: () => T): T {
  const startTime = performance.now()
  try {
    return fn()
  } finally {
    phaseSamples.push({ name, startTime, duration: performance.now() - startTime })
    if (phaseSamples.length > MAX_PHASE_SAMPLES) {
      phaseSamples.splice(0, phaseSamples.length - MAX_PHASE_SAMPLES)
    }
  }
}

export function getRecordedPhases(): readonly TabSwitchSample[] {
  return phaseSamples
}

export function _resetTabSwitchPerfForTests(): void {
  phaseSamples.length = 0
}

/** Samples overlapping [startTime, endTime]. A long task that started before the
 *  switch counts too — the switch runs inside the task that handled the click. */
export function samplesInWindow(
  samples: readonly TabSwitchSample[],
  startTime: number,
  endTime: number,
): TabSwitchSample[] {
  return samples.filter((s) => s.startTime + s.duration >= startTime && s.startTime <= endTime)
}

export interface TabSwitchReport {
  readonly label: string
  /** Delay until the first frame after the switch painted — the perceived freeze. */
  readonly firstFrameMs: number
  /** Total `longtask` time inside the observation window. */
  readonly blockedMs: number
  readonly longTasks: readonly TabSwitchSample[]
  readonly phases: readonly TabSwitchSample[]
}

export function buildTabSwitchReport(input: {
  label: string
  startTime: number
  endTime: number
  firstFrameMs: number
  longTasks: readonly TabSwitchSample[]
  phases: readonly TabSwitchSample[]
}): TabSwitchReport {
  const longTasks = samplesInWindow(input.longTasks, input.startTime, input.endTime)
  const phases = samplesInWindow(input.phases, input.startTime, input.endTime).filter(
    (p) => p.duration >= MIN_REPORTED_PHASE_MS,
  )
  return {
    label: input.label,
    firstFrameMs: input.firstFrameMs,
    blockedMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
    longTasks,
    phases,
  }
}

export function shouldWarnTabSwitch(report: TabSwitchReport): boolean {
  return Math.max(report.firstFrameMs, report.blockedMs) >= TAB_SWITCH_WARN_MS
}

export function formatTabSwitchReport(report: TabSwitchReport, startTime: number): string {
  const ms = (n: number): string => `${Math.round(n)}ms`
  const list = (samples: readonly TabSwitchSample[], name: (s: TabSwitchSample) => string) =>
    samples
      .map((s) => `${name(s)} ${ms(s.duration)} @+${Math.round(s.startTime - startTime)}ms`)
      .join(', ')
  const longTasks =
    report.longTasks.length > 0 ? ` long tasks: [${list(report.longTasks, () => 'task')}]` : ''
  const phases = report.phases.length > 0 ? ` phases: [${list(report.phases, (s) => s.name)}]` : ''
  return (
    `switch to ${report.label}: first frame ${ms(report.firstFrameMs)}, ` +
    `main thread blocked ${ms(report.blockedMs)}.${longTasks}${phases}`
  )
}
