/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge from the Swarm "Needs My Action" poll to the trigger scheduler in main.
 *  Reports the FULL displayed list (same author / approvable / ignore filters as
 *  the notification) so main can apply its persistent per-trigger dedupe; when no
 *  enabled trigger listens for `swarm.reviewNeedsAction` the bridge sends nothing
 *  at all, which keeps the default (no triggers) free of extra IPC.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { SwarmReviewDto } from '@universe-editor/extensions-common'
import {
  SWARM_TRIGGER_EVENT_NAME,
  type SwarmNeedsActionReview,
} from '../../../shared/triggers/swarmTriggerEvent.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'

/** Payload descriptions are truncated before crossing IPC (the prompt fence and
 *  the audit log never carry the full text either). */
export const SWARM_NEEDS_ACTION_DESCRIPTION_MAX = 2000

export function hasEnabledSwarmTrigger(triggers: readonly TriggerSummary[]): boolean {
  return triggers.some(
    (trigger) =>
      trigger.enabled &&
      trigger.source?.type === 'event' &&
      trigger.source.event === SWARM_TRIGGER_EVENT_NAME,
  )
}

export function toSwarmNeedsActionReview(
  review: Pick<SwarmReviewDto, 'id' | 'author' | 'description' | 'state'>,
  swarmUrl: string | undefined,
  swarmApiVersion: string | undefined,
): SwarmNeedsActionReview {
  return {
    reviewId: review.id,
    author: review.author,
    description: review.description.slice(0, SWARM_NEEDS_ACTION_DESCRIPTION_MAX),
    state: review.state,
    ...(swarmUrl !== undefined && swarmUrl.length > 0 ? { swarmUrl } : {}),
    ...(swarmApiVersion !== undefined && swarmApiVersion.length > 0 ? { swarmApiVersion } : {}),
  }
}

export interface SwarmTriggerReporterOptions {
  readonly report: (reviews: readonly SwarmNeedsActionReview[]) => Promise<void>
  /** Configured Swarm base URL; handed to the agent so its CLI calls hit the same server. */
  readonly swarmUrl: () => string | undefined
  /** Configured Swarm API version segment, so the agent's calls match the same endpoints. */
  readonly swarmApiVersion: () => string | undefined
  readonly logger?: Pick<ILogger, 'debug' | 'warn'>
}

export class SwarmTriggerReporter {
  private _triggers: readonly TriggerSummary[] = []
  private _reporting = false

  constructor(private readonly _options: SwarmTriggerReporterOptions) {}

  get enabled(): boolean {
    return hasEnabledSwarmTrigger(this._triggers)
  }

  setTriggers(triggers: readonly TriggerSummary[]): void {
    this._triggers = triggers
  }

  /** Report the current displayed list. Serialized: a slow report must not
   *  stack a second one on top (main's dedupe would absorb it, but the extra
   *  RPCs are pointless). */
  async report(reviews: readonly SwarmReviewDto[]): Promise<void> {
    if (!this.enabled || this._reporting) return
    this._reporting = true
    try {
      const swarmUrl = this._options.swarmUrl()
      const swarmApiVersion = this._options.swarmApiVersion()
      await this._options.report(
        reviews.map((review) => toSwarmNeedsActionReview(review, swarmUrl, swarmApiVersion)),
      )
      this._options.logger?.debug(`reported ${reviews.length} review(s) to triggers`)
    } catch (err) {
      this._options.logger?.warn(
        `reporting reviews to triggers failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      this._reporting = false
    }
  }
}
