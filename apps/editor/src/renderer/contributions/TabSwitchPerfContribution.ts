/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  TabSwitchPerfContribution — watchdog for slow active-editor switches. Every
 *  switch opens an observation window: a double requestAnimationFrame measures
 *  how long the previous frame stayed frozen on screen, a `longtask`
 *  PerformanceObserver totals main-thread blockage, and instrumented reactions
 *  (recordTabSwitchPhase) contribute named durations for attribution. Windows
 *  past TAB_SWITCH_WARN_MS log a warning, everything else a debug line, so a
 *  janky switch reported from the wild can be diagnosed from the window log.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  EditorInput,
  IEditorService,
  ILoggerService,
  autorun,
  createNamedLogger,
  type IEditorInput,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  TAB_SWITCH_OBSERVE_WINDOW_MS,
  buildTabSwitchReport,
  formatTabSwitchReport,
  getRecordedPhases,
  shouldWarnTabSwitch,
  type TabSwitchSample,
} from '../services/performance/tabSwitchPerf.js'

const MAX_TASK_SAMPLES = 128

interface PendingSwitch {
  readonly label: string
  readonly startTime: number
  firstFrameMs: number | undefined
  finalized: boolean
}

export class TabSwitchPerfContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private readonly _longTasks: TabSwitchSample[] = []
  private _observer: PerformanceObserver | undefined
  private _pending: PendingSwitch | undefined

  constructor(
    @IEditorService editorService: IEditorService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'tabSwitchPerf',
      name: 'Tab Switch Performance',
    })
    this._observeLongTasks()
    let initial = true
    this._register(
      autorun((reader) => {
        const input = editorService.activeEditor.read(reader)
        // The autorun's first run reports the editor restored at startup, not a
        // user switch — startup cost is the Startup Performance report's turf.
        if (initial) {
          initial = false
          return
        }
        this._beginMeasurement(input)
      }),
    )
  }

  private _beginMeasurement(input: IEditorInput | undefined): void {
    // A switch arriving mid-window truncates the previous measurement instead
    // of dropping it: rapid back-and-forth switching is exactly the scenario
    // that must not lose its reports.
    this._finalize(this._pending)
    const pending: PendingSwitch = {
      label: describeInput(input),
      startTime: performance.now(),
      firstFrameMs: undefined,
      finalized: false,
    }
    this._pending = pending
    // Double rAF: the first fires before the switch's frame paints, the second
    // after — the delay is how long the user stared at the frozen old frame.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!pending.finalized) pending.firstFrameMs = performance.now() - pending.startTime
      }),
    )
    setTimeout(() => this._finalize(pending), TAB_SWITCH_OBSERVE_WINDOW_MS)
  }

  private _finalize(pending: PendingSwitch | undefined): void {
    if (!pending || pending.finalized || this._store.isDisposed) return
    pending.finalized = true
    if (this._pending === pending) this._pending = undefined
    // Flush entries the observer callback has not delivered yet.
    for (const entry of this._observer?.takeRecords() ?? []) this._pushLongTask(entry)
    const endTime = performance.now()
    const report = buildTabSwitchReport({
      label: pending.label,
      startTime: pending.startTime,
      endTime,
      // rAF never fired = the main thread stayed blocked for the whole window
      // (or it was truncated first); the elapsed time is the lower bound.
      firstFrameMs: pending.firstFrameMs ?? endTime - pending.startTime,
      longTasks: this._longTasks,
      phases: getRecordedPhases(),
    })
    const line = formatTabSwitchReport(report, pending.startTime)
    if (shouldWarnTabSwitch(report)) this._logger.warn(line)
    else this._logger.debug(line)
  }

  private _observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) this._pushLongTask(entry)
      })
      observer.observe({ entryTypes: ['longtask'] })
      this._observer = observer
      this._register({ dispose: () => observer.disconnect() })
    } catch {
      // No longtask support (tests / headless) — the first-frame delay alone
      // still catches synchronous freezes.
    }
  }

  private _pushLongTask(entry: { startTime: number; duration: number }): void {
    this._longTasks.push({ name: 'longtask', startTime: entry.startTime, duration: entry.duration })
    if (this._longTasks.length > MAX_TASK_SAMPLES) {
      this._longTasks.splice(0, this._longTasks.length - MAX_TASK_SAMPLES)
    }
  }
}

function describeInput(input: IEditorInput | undefined): string {
  if (!input) return '<none>'
  if (input instanceof EditorInput) return input.resource?.toString() ?? input.label
  return input.label
}
