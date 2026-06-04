/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shows the total startup time in the status bar when it exceeds a configurable
 *  threshold. Clicking the entry opens the Startup Performance report.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IStatusBarService,
  IWindowsService,
  IWorkbenchContribution,
  StatusBarAlignment,
  localize,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { ITimerService, type IStartupMetrics } from '../services/performance/TimerService.js'
import { ShowStartupPerformanceAction } from '../actions/performanceActions.js'
import {
  STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY,
  STARTUP_WARNING_ENABLED_KEY,
  STARTUP_WARNING_RELEASE_THRESHOLD_KEY,
  startupWarningEnabled,
  startupWarningThresholdMs,
} from '../services/performance/startupPerformanceSettings.js'

export class StartupPerformanceStatusContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _entry: IStatusBarEntryAccessor | undefined
  private _metricsPromise: Promise<IStartupMetrics> | undefined
  private _isCurrentWindowFirstPromise: Promise<boolean> | undefined
  private _renderGeneration = 0

  constructor(
    @ITimerService private readonly _timer: ITimerService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IWindowsService private readonly _windows: IWindowsService,
  ) {
    super()
    this._register({ dispose: () => this._entry?.dispose() })
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (
          !e.affectsConfiguration(STARTUP_WARNING_ENABLED_KEY) &&
          !e.affectsConfiguration(STARTUP_WARNING_RELEASE_THRESHOLD_KEY) &&
          !e.affectsConfiguration(STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY)
        ) {
          return
        }
        void this._renderIfFirstWindow()
      }),
    )
    void this._renderIfFirstWindow()
  }

  private async _renderIfFirstWindow(): Promise<void> {
    if (!(await this._isCurrentWindowFirst())) {
      this._hide()
      return
    }
    await this._render()
  }

  private async _render(): Promise<void> {
    const generation = ++this._renderGeneration
    if (!startupWarningEnabled(this._configuration, import.meta.env.DEV)) {
      this._hide()
      return
    }

    const metrics = await this._getStartupMetrics()
    if (generation !== this._renderGeneration) return
    const threshold = startupWarningThresholdMs(this._configuration, import.meta.env.DEV)
    if (metrics.totalTime <= threshold) {
      this._hide()
      return
    }

    const seconds = (metrics.totalTime / 1000).toFixed(2)
    const entry: IStatusBarEntry = {
      text: `$(dashboard) ${seconds}s`,
      icon: 'dashboard',
      kind: 'prominent',
      tooltip: localize(
        'performance.statusbar.tooltip',
        'Startup took {seconds}s — click to view the report',
        { seconds },
      ),
      command: ShowStartupPerformanceAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 100,
    }
    if (this._entry) this._entry.update(entry)
    else this._entry = this._statusBar.addEntry(entry)
  }

  private _getStartupMetrics(): Promise<IStartupMetrics> {
    this._metricsPromise ??= this._timer.getStartupMetrics()
    return this._metricsPromise
  }

  private _isCurrentWindowFirst(): Promise<boolean> {
    this._isCurrentWindowFirstPromise ??= this._windows.isCurrentWindowFirst().catch(() => false)
    return this._isCurrentWindowFirstPromise
  }

  private _hide(): void {
    this._entry?.dispose()
    this._entry = undefined
  }
}
