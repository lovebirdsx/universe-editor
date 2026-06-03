/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aggregates performance marks from both processes into a single startup
 *  timeline. The renderer-side base for VSCode-style startup performance and any
 *  future timing metrics.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  getMarks,
  InstantiationType,
  registerSingleton,
  type PerformanceMark,
} from '@universe-editor/platform'
import { IPerformanceMarksService } from '../../../shared/ipc/services.js'
import { PerfMarks } from '../../../shared/perf/marks.js'

export interface IStartupPhase {
  /** Friendly name of the segment (the milestone it ends at). */
  readonly label: string
  readonly from: string
  readonly to: string
  /** Duration in milliseconds. */
  readonly duration: number
}

export interface IStartupMetrics {
  /** main `code/timeOrigin` → renderer workbench mount, in milliseconds. */
  readonly totalTime: number
  readonly phases: readonly IStartupPhase[]
  /** Merged main + renderer marks, sorted by startTime. */
  readonly marks: readonly PerformanceMark[]
}

export interface ITimerService {
  readonly _serviceBrand: undefined
  getStartupMetrics(): Promise<IStartupMetrics>
  /** Merged main + renderer marks, sorted by startTime. */
  getPerfMarks(): Promise<PerformanceMark[]>
}

export const ITimerService = createDecorator<ITimerService>('timerService')

interface IMilestone {
  readonly mark: string
  readonly label: string
}

// Ordered startup milestones; adjacent pairs become phases. Missing marks are
// skipped (e.g. a not-yet-reached phase), so the timeline stays contiguous.
const MILESTONES: readonly IMilestone[] = [
  { mark: PerfMarks.mainDidStart, label: 'Main process started' },
  { mark: PerfMarks.mainAppReady, label: 'Electron app ready' },
  { mark: PerfMarks.mainDidCreateServices, label: 'Main services created' },
  { mark: PerfMarks.mainWillCreateWindow, label: 'Creating window' },
  { mark: PerfMarks.mainDidShowWindow, label: 'Window shown' },
  { mark: PerfMarks.rendererWillStartBootstrap, label: 'Renderer bootstrap' },
  { mark: PerfMarks.rendererDidCreateIpc, label: 'IPC ready' },
  { mark: PerfMarks.rendererWillRestore, label: 'Ready phase' },
  { mark: PerfMarks.rendererDidRestoreServices, label: 'Services restored' },
  { mark: PerfMarks.rendererDidMount, label: 'Workbench mounted' },
  { mark: PerfMarks.rendererDidRestoreEditors, label: 'Editors restored' },
]

export class TimerService implements ITimerService {
  declare readonly _serviceBrand: undefined

  constructor(@IPerformanceMarksService private readonly _mainMarks: IPerformanceMarksService) {}

  async getPerfMarks(): Promise<PerformanceMark[]> {
    const mainMarks = await this._safeMainMarks()
    return [...mainMarks, ...getMarks()].sort((a, b) => a.startTime - b.startTime)
  }

  async getStartupMetrics(): Promise<IStartupMetrics> {
    const marks = await this.getPerfMarks()

    // name → earliest startTime (both processes inject `code/timeOrigin`; the
    // main one is earlier and wins).
    const at = new Map<string, number>()
    for (const m of marks) {
      const prev = at.get(m.name)
      if (prev === undefined || m.startTime < prev) at.set(m.name, m.startTime)
    }

    const present = MILESTONES.filter((ms) => at.has(ms.mark))
    const phases: IStartupPhase[] = []
    for (let i = 1; i < present.length; i++) {
      const from = present[i - 1]
      const to = present[i]
      if (!from || !to) continue
      const fromTime = at.get(from.mark)
      const toTime = at.get(to.mark)
      if (fromTime === undefined || toTime === undefined) continue
      phases.push({ label: to.label, from: from.label, to: to.label, duration: toTime - fromTime })
    }

    const firstPresent = present[0]
    const lastPresent = present[present.length - 1]
    const origin = at.get(PerfMarks.timeOrigin) ?? (firstPresent ? at.get(firstPresent.mark) : 0)
    const end =
      at.get(PerfMarks.rendererDidMount) ?? (lastPresent ? at.get(lastPresent.mark) : origin)
    const totalTime = (end ?? 0) - (origin ?? 0)

    return { totalTime, phases, marks }
  }

  private async _safeMainMarks(): Promise<PerformanceMark[]> {
    try {
      return await this._mainMarks.getMarks()
    } catch {
      // Main marks are best-effort: still show the renderer timeline if the
      // channel is unavailable (e.g. unit tests, early failures).
      return []
    }
  }
}

registerSingleton(ITimerService, TimerService, InstantiationType.Delayed)
