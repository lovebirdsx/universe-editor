/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Schedules extension-update checks and owns their two indicators: the Extensions
 *  Activity Bar badge and the `extensionsHasUpdates` context key. The decision of
 *  what to install lives in ExtensionsUpdateService; this is only the cadence.
 *
 *  There is no `restart required` surface: an install already restarts the extension
 *  host via ExtensionsContribution's onDidChangeExtensions handler, so an update is
 *  live seconds after it lands.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IContextKeyService,
  IWorkbenchContribution,
  MutableDisposable,
  type IContextKey,
  type IDisposable,
} from '@universe-editor/platform'
import { IExtensionsWorkbenchService } from '../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import {
  EXTENSIONS_HAS_UPDATES_KEY,
  EXTENSIONS_VIEW_CONTAINER_ID,
} from '../services/extensionsWorkbench/extensionsViewIds.js'
import { IExtensionsUpdateService } from '../services/extensionsUpdates/ExtensionsUpdateService.js'
import { IActivityService } from '../services/activity/ActivityService.js'

/** VSCode parity: `extensions.autoCheckUpdates` runs on this cadence. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Delay the first check so it never competes with startup work. */
const FIRST_CHECK_DELAY_MS = 30_000

/** Floor for the re-check armed by the publish delay, so a clock skew can't spin. */
const MIN_RECHECK_MS = 1_000

export class ExtensionsUpdateContribution extends Disposable implements IWorkbenchContribution {
  private _firstCheck: ReturnType<typeof setTimeout> | undefined
  private _interval: ReturnType<typeof setInterval> | undefined
  private _delayRecheck: ReturnType<typeof setTimeout> | undefined
  private _checking = false
  private _disposed = false
  private readonly _hasUpdates: IContextKey<boolean>
  private readonly _badge = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IExtensionsWorkbenchService
    private readonly _workbench: IExtensionsWorkbenchService,
    @IExtensionsUpdateService private readonly _updates: IExtensionsUpdateService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IActivityService private readonly _activity: IActivityService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super()
    this._hasUpdates = contextKeyService.createKey<boolean>(EXTENSIONS_HAS_UPDATES_KEY, false)
    this._register({
      dispose: () => {
        this._disposed = true
        this._clearTimers()
        this._hasUpdates.reset()
      },
    })
    this._register(this._workbench.onDidChange(() => this._refreshIndicators()))
    // ConfigurationService.affectsConfiguration is an exact-key match, not a section
    // prefix — every key has to be enumerated here.
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('extensions.autoCheckUpdates') ||
          e.affectsConfiguration('extensions.autoUpdate') ||
          e.affectsConfiguration('extensions.autoUpdateDelay')
        ) {
          this._reschedule()
        }
      }),
    )
    this._refreshIndicators()
    this._reschedule()
  }

  private _reschedule(): void {
    this._clearTimers()
    if (this._configuration.get<boolean>('extensions.autoCheckUpdates', true) === false) return
    this._firstCheck = setTimeout(() => {
      this._firstCheck = undefined
      void this._runCheck()
    }, FIRST_CHECK_DELAY_MS)
    this._interval = setInterval(() => void this._runCheck(), CHECK_INTERVAL_MS)
  }

  private _clearTimers(): void {
    if (this._firstCheck !== undefined) clearTimeout(this._firstCheck)
    if (this._interval !== undefined) clearInterval(this._interval)
    if (this._delayRecheck !== undefined) clearTimeout(this._delayRecheck)
    this._firstCheck = undefined
    this._interval = undefined
    this._delayRecheck = undefined
  }

  private async _runCheck(): Promise<void> {
    if (this._disposed || this._checking) return
    this._checking = true
    try {
      const result = await this._updates.check({ auto: true })
      if (result.nextEligibleAt !== undefined) this._armDelayRecheck(result.nextEligibleAt)
    } catch {
      // A failed cycle is reported by the facade; the timer keeps its cadence.
    } finally {
      this._checking = false
    }
  }

  /** A candidate inside the publish-delay window re-checks once it becomes eligible. */
  private _armDelayRecheck(at: number): void {
    // A cycle that resolves after dispose must not arm a timer on a dead contribution.
    if (this._disposed) return
    if (this._delayRecheck !== undefined) clearTimeout(this._delayRecheck)
    this._delayRecheck = setTimeout(
      () => {
        this._delayRecheck = undefined
        void this._runCheck()
      },
      Math.max(at - Date.now(), MIN_RECHECK_MS),
    )
  }

  private _refreshIndicators(): void {
    // A disabled extension is not badged: it will not run until the user re-enables it.
    const count = this._workbench
      .getInstalled()
      .filter((entry) => entry.updateVersion !== undefined && entry.enabled).length
    this._badge.value =
      count > 0 ? this._activity.showActivity(EXTENSIONS_VIEW_CONTAINER_ID, { count }) : undefined
    this._hasUpdates.set(count > 0)
  }
}
