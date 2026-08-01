/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Tab-switch jank reporting. TabSwitchPerfContribution correlates recorded
 *  perf phases (see perfPhases.ts) with `longtask` entries inside each
 *  switch's observation window and logs a warning when the main thread was
 *  blocked past the threshold — so a slow switch in the wild leaves an
 *  attributable trace in the window log instead of an unexplained freeze.
 *--------------------------------------------------------------------------------------------*/

import { samplesInWindow, type PerfSample } from './perfPhases.js'

/** A switch is logged as a warning past this much freeze / main-thread blockage. */
export const TAB_SWITCH_WARN_MS = 200

/** Deferred reactions (200ms throttled re-diffs / re-scans, async providers)
 *  land well after the switch itself but still belong to it. */
export const TAB_SWITCH_OBSERVE_WINDOW_MS = 1500

/** Phases shorter than this are healthy noise — dropped from reports. */
const MIN_REPORTED_PHASE_MS = 1

export interface TabSwitchReport {
  readonly label: string
  /** Delay until the first frame after the switch painted — the perceived freeze. */
  readonly firstFrameMs: number
  /** Total `longtask` time inside the observation window. */
  readonly blockedMs: number
  readonly longTasks: readonly PerfSample[]
  readonly phases: readonly PerfSample[]
}

export function buildTabSwitchReport(input: {
  label: string
  startTime: number
  endTime: number
  firstFrameMs: number
  longTasks: readonly PerfSample[]
  phases: readonly PerfSample[]
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
  const list = (samples: readonly PerfSample[], name: (s: PerfSample) => string) =>
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
