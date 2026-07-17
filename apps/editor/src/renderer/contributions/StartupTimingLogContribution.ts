/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persists one startup timeline to the shared main log after the first window
 *  mounts, tagged with whether this is a post-update first launch. A slow first
 *  launch right after an auto-update (antivirus first-scanning the freshly written
 *  exe/asar) is otherwise invisible: the in-memory Startup Performance report is
 *  never opened on that exact launch. Logging it lets the timeline be compared
 *  against steady-state launches after the fact. Measurement only — no UI.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWindowsService, IWorkbenchContribution } from '@universe-editor/platform'
import { IPerformanceMarksService } from '../../shared/ipc/services.js'
import { ITimerService } from '../services/performance/TimerService.js'
import { PerfMarks } from '../../shared/perf/marks.js'

export class StartupTimingLogContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @ITimerService private readonly _timer: ITimerService,
    @IPerformanceMarksService private readonly _performance: IPerformanceMarksService,
    @IWindowsService private readonly _windows: IWindowsService,
  ) {
    super()
    void this._report()
  }

  private async _report(): Promise<void> {
    // Only the first window logs: the timeline is application-wide (main marks are
    // shared), so a second window would log a redundant, misleading line.
    if (!(await this._windows.isCurrentWindowFirst().catch(() => false))) return

    const metrics = await this._timer.getStartupMetrics()
    const at = (name: string): number | undefined =>
      metrics.marks.find((m) => m.name === name)?.startTime
    const created = at(PerfMarks.mainProcessCreated)
    const didStart = at(PerfMarks.mainDidStart)
    const preJsGapMs =
      created !== undefined && didStart !== undefined ? didStart - created : undefined

    await this._performance
      .reportStartupTiming({
        totalTime: metrics.totalTime,
        phases: metrics.phases.map((p) => ({ label: p.label, duration: p.duration })),
        ...(preJsGapMs !== undefined ? { preJsGapMs } : {}),
      })
      .catch(() => undefined)
  }
}
