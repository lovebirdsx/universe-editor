/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Gates the always-on interaction responsiveness floor on configuration:
 *  starts the service's observers when enabled (default on, release builds
 *  included — passive observers cost ~nothing), applies warn-threshold
 *  changes live, and stops cleanly when the user turns monitoring off.
 *  Optionally surfaces a status-bar warning (default off) when slow
 *  interactions cluster inside a sliding one-minute window.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IStatusBarService,
  StatusBarAlignment,
  localize,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IInteractionPerfService } from '../services/performance/InteractionPerfService.js'
import type { SlowInteractionReport } from '../services/performance/interactionPerf.js'
import {
  RESPONSIVENESS_ENABLED_KEY,
  RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY,
  RESPONSIVENESS_WARN_THRESHOLD_KEY,
  responsivenessEnabled,
  responsivenessStatusWarningEnabled,
  responsivenessWarnThresholdMs,
} from '../services/performance/interactionPerfSettings.js'
import { ShowInteractionPerformanceAction } from '../actions/performanceActions.js'

const STATUS_WARNING_WINDOW_MS = 60_000
const STATUS_WARNING_MIN_SLOW = 5
const STATUS_WARNING_DECAY_TICK_MS = 30_000
// Same-frame events can be a few milliseconds apart; anything inside this gap
// is still one jank frame, not a second stall.
const STALL_MERGE_TOLERANCE_MS = 5

interface SlowStall {
  /** Wall-clock arrival, used only for the sliding window. */
  readonly arrivedAt: number
  /** End of the stall on the performance timeline; extended as reports merge. */
  endTime: number
}

export class InteractionPerfContribution extends Disposable implements IWorkbenchContribution {
  private _running = false
  private _entry: IStatusBarEntryAccessor | undefined
  private readonly _slowStalls: SlowStall[] = []

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IInteractionPerfService private readonly _interactionPerf: IInteractionPerfService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
  ) {
    super()
    this._register({ dispose: () => this._entry?.dispose() })
    this._register(
      this._interactionPerf.onDidRecordSlowInteraction((report) => {
        this._recordSlowReport(report)
        this._evaluateStatusWarning()
      }),
    )
    // Slow interactions stop → the window drains on this tick and the entry hides.
    const decayTimer = setInterval(
      () => this._evaluateStatusWarning(),
      STATUS_WARNING_DECAY_TICK_MS,
    )
    this._register({ dispose: () => clearInterval(decayTimer) })
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY)) {
          this._evaluateStatusWarning()
        }
        if (
          !e.affectsConfiguration(RESPONSIVENESS_ENABLED_KEY) &&
          !e.affectsConfiguration(RESPONSIVENESS_WARN_THRESHOLD_KEY)
        ) {
          return
        }
        this._apply()
      }),
    )
    this._apply()
  }

  private _apply(): void {
    const enabled = responsivenessEnabled(this._configuration)
    const warnThresholdMs = responsivenessWarnThresholdMs(this._configuration)
    if (enabled) {
      // start() is idempotent — re-applying just refreshes the threshold.
      this._interactionPerf.start({ warnThresholdMs })
      this._running = true
    } else if (this._running) {
      this._interactionPerf.stop()
      this._running = false
    }
  }

  /**
   * One jank frame produces several Event Timing entries (pointerdown, mouseup,
   * pointerover, …) whose windows overlap or touch. Fold those into the stall
   * already on the books instead of counting each report.
   */
  private _recordSlowReport(report: SlowInteractionReport): void {
    const endTime = report.startTime + report.durationMs
    const last = this._slowStalls[this._slowStalls.length - 1]
    if (last && report.startTime <= last.endTime + STALL_MERGE_TOLERANCE_MS) {
      last.endTime = Math.max(last.endTime, endTime)
    } else {
      // startTime lives on the performance timeline; the window needs wall clock.
      this._slowStalls.push({ arrivedAt: Date.now(), endTime })
    }
  }

  private _evaluateStatusWarning(): void {
    if (!responsivenessStatusWarningEnabled(this._configuration)) {
      this._hideStatusWarning()
      return
    }
    const cutoff = Date.now() - STATUS_WARNING_WINDOW_MS
    while (this._slowStalls.length > 0 && this._slowStalls[0]!.arrivedAt < cutoff) {
      this._slowStalls.shift()
    }
    if (this._slowStalls.length < STATUS_WARNING_MIN_SLOW) {
      this._hideStatusWarning()
      return
    }
    const count = this._slowStalls.length
    const entry: IStatusBarEntry = {
      text: `$(pulse) ${count}`,
      kind: 'prominent',
      tooltip: localize(
        'performance.responsiveness.statusbar.tooltip',
        '{count} slow responses in the last minute — click to view the report',
        { count },
      ),
      command: ShowInteractionPerformanceAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 99,
    }
    if (this._entry) this._entry.update(entry)
    else this._entry = this._statusBar.addEntry(entry)
  }

  private _hideStatusWarning(): void {
    this._entry?.dispose()
    this._entry = undefined
  }
}
