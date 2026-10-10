/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One extension-update cycle: refresh the pending set, then install whatever the
 *  auto-update policy allows. The only place that reads `extensions.autoUpdate` /
 *  `extensions.autoUpdateDelay` and applies updates without a prompt, kept apart
 *  from the contribution so the cycle is testable without timers or a lifecycle
 *  (and drivable deterministically from the e2e probe).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IConfigurationService, createDecorator } from '@universe-editor/platform'
import { IExtensionsWorkbenchService } from '../extensionsWorkbench/ExtensionsWorkbenchService.js'
import type { IExtensionUpdate } from '../../../shared/ipc/extensionManagementService.js'
import {
  parsePublishedAt,
  planAutoUpdates,
  type IAutoUpdateCandidate,
} from './extensionUpdatePolicy.js'

export interface IExtensionsUpdateCycleResult {
  readonly updates: readonly IExtensionUpdate[]
  /**
   * Epoch ms at which a deferred candidate becomes eligible; set only when a
   * background cycle skipped something for the publish delay.
   */
  readonly nextEligibleAt?: number
}

export interface IExtensionsUpdateService {
  readonly _serviceBrand: undefined

  /**
   * Run one update cycle. `auto` marks a background cycle: it may install updates
   * without asking (subject to the settings + per-extension opt-out), and reports
   * nothing to the user beyond what the facade already surfaces.
   */
  check(options?: { auto?: boolean }): Promise<IExtensionsUpdateCycleResult>
}

export const IExtensionsUpdateService =
  createDecorator<IExtensionsUpdateService>('extensionsUpdateService')

export class ExtensionsUpdateService extends Disposable implements IExtensionsUpdateService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IExtensionsWorkbenchService private readonly _workbench: IExtensionsWorkbenchService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
  ) {
    super()
  }

  async check(options: { auto?: boolean } = {}): Promise<IExtensionsUpdateCycleResult> {
    const auto = options.auto === true
    const updates = await this._workbench.checkForUpdates({ explicit: !auto })
    if (!auto || updates.length === 0) return { updates }
    if (this._configuration.get<boolean>('extensions.autoUpdate', true) === false) {
      return { updates }
    }

    const entries = new Map(this._workbench.getInstalled().map((entry) => [entry.id, entry]))
    const candidates: IAutoUpdateCandidate[] = []
    for (const update of updates) {
      const entry = entries.get(update.identifier)
      if (!entry) continue
      candidates.push({
        identifier: update.identifier,
        enabled: entry.enabled,
        optedOut: entry.autoUpdate === false,
        publishedAt: parsePublishedAt(update.gallery.lastUpdated),
      })
    }

    const plan = planAutoUpdates(candidates, { now: Date.now(), delayMs: this._delayMs() })
    if (plan.apply.length > 0) await this._workbench.updateAll(plan.apply, { silent: true })

    return plan.nextEligibleAt !== undefined
      ? { updates, nextEligibleAt: plan.nextEligibleAt }
      : { updates }
  }

  /** Configured publish delay in ms; 0 when unset, non-positive or unparseable. */
  private _delayMs(): number {
    const hours = this._configuration.get<number>('extensions.autoUpdateDelay', 2)
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return 0
    return hours * 60 * 60 * 1000
  }
}
