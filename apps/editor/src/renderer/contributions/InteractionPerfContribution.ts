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

export class InteractionPerfContribution extends Disposable implements IWorkbenchContribution {
  private _running = false
  private _entry: IStatusBarEntryAccessor | undefined
  private readonly _slowTimestamps: number[] = []

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IInteractionPerfService private readonly _interactionPerf: IInteractionPerfService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
  ) {
    super()
    this._register({ dispose: () => this._entry?.dispose() })
    this._register(
      this._interactionPerf.onDidRecordSlowInteraction(() => {
        this._slowTimestamps.push(Date.now())
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

  private _evaluateStatusWarning(): void {
    if (!responsivenessStatusWarningEnabled(this._configuration)) {
      this._hideStatusWarning()
      return
    }
    const cutoff = Date.now() - STATUS_WARNING_WINDOW_MS
    while (this._slowTimestamps.length > 0 && this._slowTimestamps[0]! < cutoff) {
      this._slowTimestamps.shift()
    }
    if (this._slowTimestamps.length < STATUS_WARNING_MIN_SLOW) {
      this._hideStatusWarning()
      return
    }
    const count = this._slowTimestamps.length
    const entry: IStatusBarEntry = {
      text: `$(pulse) ${count}`,
      icon: 'pulse',
      kind: 'prominent',
      tooltip: localize(
        'performance.responsiveness.statusbar.tooltip',
        '{count} slow interactions in the last minute — click to view the report',
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
