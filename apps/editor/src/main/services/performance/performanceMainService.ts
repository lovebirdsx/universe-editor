/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Exposes the main process's performance marks over IPC, and owns the
 *  post-update-first-launch detection: it compares the running version against the
 *  last one persisted in main storage, then logs the renderer-supplied startup
 *  timeline (tagged post-update or steady-state) to the shared main log. This makes
 *  a slow first launch after an auto-update measurable without the user having to
 *  open the Startup Performance report on that exact launch.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import {
  createNamedLogger,
  getMarks,
  type ILogger,
  ILoggerService,
  type PerformanceMark,
} from '@universe-editor/platform'
import type {
  IPerformanceMarksService,
  StartupContext,
  StartupTimingReport,
} from '../../../shared/ipc/services.js'
import type { Storage } from '../../storage.js'

const LAST_RUN_VERSION_KEY = 'startup.lastRunVersion'

export class PerformanceMainService implements IPerformanceMarksService {
  declare readonly _serviceBrand: undefined

  private readonly _currentVersion = app.getVersion()
  private readonly _logger: ILogger
  private _contextPromise: Promise<StartupContext> | undefined

  constructor(
    private readonly _storage: Storage,
    loggerService: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'startupPerf', name: 'Startup Perf' })
  }

  getMarks(): Promise<PerformanceMark[]> {
    return Promise.resolve(getMarks())
  }

  getStartupContext(): Promise<StartupContext> {
    // Compute once: reading + rewriting the persisted version must happen a single
    // time per launch, or a second window would see its own write as "same version".
    this._contextPromise ??= this._computeStartupContext()
    return this._contextPromise
  }

  async reportStartupTiming(report: StartupTimingReport): Promise<void> {
    const ctx = await this.getStartupContext()
    const versionJump = ctx.postUpdate ? ` prev=${ctx.previousVersion ?? '<none>'}` : ''
    const preJs =
      report.preJsGapMs !== undefined ? ` preJsGap=${Math.round(report.preJsGapMs)}ms` : ''
    const phases = report.phases.map((p) => `${p.label}:${Math.round(p.duration)}ms`).join(', ')
    this._logger.info(
      `startup postUpdate=${ctx.postUpdate} cur=${ctx.currentVersion}${versionJump} ` +
        `total=${Math.round(report.totalTime)}ms${preJs} [${phases}]`,
    )
  }

  private async _computeStartupContext(): Promise<StartupContext> {
    let previousVersion: string | undefined
    try {
      previousVersion = await this._storage.get<string>(LAST_RUN_VERSION_KEY)
    } catch (err) {
      this._logger.warn(`read ${LAST_RUN_VERSION_KEY} failed: ${String(err)}`)
    }
    // A missing previous version is a fresh install, not an update; only a genuine
    // version change counts as post-update.
    const postUpdate = previousVersion !== undefined && previousVersion !== this._currentVersion
    if (previousVersion !== this._currentVersion) {
      try {
        await this._storage.set(LAST_RUN_VERSION_KEY, this._currentVersion)
      } catch (err) {
        this._logger.warn(`persist ${LAST_RUN_VERSION_KEY} failed: ${String(err)}`)
      }
    }
    return {
      postUpdate,
      currentVersion: this._currentVersion,
      ...(previousVersion !== undefined ? { previousVersion } : {}),
    }
  }
}
