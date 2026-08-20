/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Exposes the main process's performance marks over IPC, and owns the
 *  post-update-first-launch detection: it compares the running version against the
 *  last one persisted in main storage, then logs the renderer-supplied startup
 *  timeline (tagged post-update or steady-state) to the shared main log. This makes
 *  a slow first launch after an auto-update measurable without the user having to
 *  open the Startup Performance report on that exact launch.
 *--------------------------------------------------------------------------------------------*/

import { getAppVersion } from '../../appVersion.js'
import {
  createNamedLogger,
  getMarks,
  getOriginalConsole,
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
import { PerfMarks } from '../../../shared/perf/marks.js'

const LAST_RUN_VERSION_KEY = 'startup.lastRunVersion'

export class PerformanceMainService implements IPerformanceMarksService {
  declare readonly _serviceBrand: undefined

  private readonly _currentVersion = getAppVersion()
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
    const kind = report.isReload ? 'reload' : `startup postUpdate=${ctx.postUpdate}`
    this._logger.info(
      `${kind} cur=${ctx.currentVersion}${versionJump} ` +
        `total=${Math.round(report.totalTime)}ms${preJs} [${phases}]`,
    )
    if (!report.isReload) this._logStartupWallClock(report.totalTime)
  }

  // Print the full wall clock from the moment `pnpm dev` / `pnpm dev:run` was typed to
  // the window being responsive. The wrapper scripts stamp an epoch-ms T0 into env
  // before spawning: scripts/dev.mjs → UNIVERSE_DEV_T0 (before electron-vite dev),
  // scripts/dev-run.mjs → UNIVERSE_DEVRUN_T0 (after build, before spawning Electron on
  // the out-dev/ bundle). report.totalTime spans OS-process-creation → window mount, and
  // (processCreated − T0) is the pre-JS segment no in-process perf mark can see: for
  // dev it's electron-vite compile + spawn, for dev:run it's the bare Electron spawn.
  // A real packaged install has no wrapper and stamps no env, so this stays silent.
  // Printed via the original console so it survives the console interceptor and lands
  // in the launching terminal.
  private _logStartupWallClock(totalTime: number): void {
    const devT0 = Number(process.env.UNIVERSE_DEV_T0)
    const devRunT0 = Number(process.env.UNIVERSE_DEVRUN_T0)
    const [label, preSpawnLabel, t0] = Number.isFinite(devT0)
      ? (['pnpm dev', 'compile+spawn', devT0] as const)
      : Number.isFinite(devRunT0)
        ? (['pnpm dev:run', 'spawn', devRunT0] as const)
        : (['', '', NaN] as const)
    if (!Number.isFinite(t0)) return
    const processCreated = getMarks().find(
      (m) => m.name === PerfMarks.mainProcessCreated,
    )?.startTime
    if (processCreated === undefined) return
    const preSpawn = processCreated - t0
    const fullWallClock = preSpawn + totalTime
    getOriginalConsole().log(
      `\x1b[36m[startup] ${label} -> window responsive: ${Math.round(fullWallClock)}ms\x1b[0m ` +
        `(${preSpawnLabel} ${Math.round(preSpawn)}ms + in-process ${Math.round(totalTime)}ms)`,
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
