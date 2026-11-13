/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge from the Swarm "Needs My Action" poll to the trigger scheduler in main.
 *  Reports the FULL displayed list (same author / approvable / ignore filters as
 *  the notification) so main can apply its persistent per-trigger dedupe; when no
 *  enabled `swarm-review` trigger exists the bridge sends nothing at all, which
 *  keeps the default (no triggers) free of extra IPC.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { SwarmReviewDto } from '@universe-editor/extensions-common'
import type { SwarmNeedsActionReview } from '../../../shared/ipc/triggerService.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'

/** Payload descriptions are truncated before crossing IPC (the prompt fence and
 *  the audit log never carry the full text either). */
export const SWARM_NEEDS_ACTION_DESCRIPTION_MAX = 2000

export function hasEnabledSwarmTrigger(triggers: readonly TriggerSummary[]): boolean {
  return triggers.some((trigger) => trigger.enabled && trigger.sourceType === 'swarm-review')
}

export function toSwarmNeedsActionReview(
  review: Pick<SwarmReviewDto, 'id' | 'author' | 'description' | 'state' | 'updated'>,
  version: number | undefined,
): SwarmNeedsActionReview {
  return {
    reviewId: review.id,
    author: review.author,
    description: review.description.slice(0, SWARM_NEEDS_ACTION_DESCRIPTION_MAX),
    state: review.state,
    updated: review.updated,
    ...(version !== undefined ? { version } : {}),
  }
}

/** Result of one `getReview` lookup: undefined means the lookup failed (retry
 *  next tick); an object may still lack `version` when the review has no versions. */
export interface SwarmReviewVersionLookup {
  readonly version?: number
}

export interface SwarmTriggerReporterOptions {
  readonly report: (reviews: readonly SwarmNeedsActionReview[]) => Promise<void>
  readonly getReviewVersion: (reviewId: string) => Promise<SwarmReviewVersionLookup | undefined>
  readonly logger?: Pick<ILogger, 'debug' | 'warn'>
}

interface CachedVersion {
  readonly updated: number
  readonly version?: number
}

export class SwarmTriggerReporter {
  private _triggers: readonly TriggerSummary[] = []
  private readonly _versions = new Map<string, CachedVersion>()
  private _reporting = false

  constructor(private readonly _options: SwarmTriggerReporterOptions) {}

  get enabled(): boolean {
    return hasEnabledSwarmTrigger(this._triggers)
  }

  setTriggers(triggers: readonly TriggerSummary[]): void {
    this._triggers = triggers
  }

  /** Report the current displayed list. Serialized: a slow version lookup must
   *  not stack a second report on top (main's dedupe would absorb it, but the
   *  extra RPCs are pointless). */
  async report(reviews: readonly SwarmReviewDto[]): Promise<void> {
    if (!this.enabled || this._reporting) return
    this._reporting = true
    try {
      this._pruneVersions(reviews)
      const versions = await this._loadVersions(reviews)
      await this._options.report(
        reviews.map((review) => toSwarmNeedsActionReview(review, versions.get(review.id))),
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

  private _pruneVersions(reviews: readonly SwarmReviewDto[]): void {
    const live = new Set(reviews.map((review) => review.id))
    for (const id of this._versions.keys()) {
      if (!live.has(id)) this._versions.delete(id)
    }
  }

  /** One detail lookup per review, reused until the review's `updated` stamp
   *  moves — a re-shelve or vote is exactly what changes the version guard. */
  private async _loadVersions(
    reviews: readonly SwarmReviewDto[],
  ): Promise<Map<string, number | undefined>> {
    const versions = new Map<string, number | undefined>()
    await Promise.all(
      reviews.map(async (review) => {
        const cached = this._versions.get(review.id)
        if (cached !== undefined && cached.updated === review.updated) {
          versions.set(review.id, cached.version)
          return
        }
        const lookup = await this._options.getReviewVersion(review.id).catch(() => undefined)
        if (lookup !== undefined) {
          this._versions.set(review.id, {
            updated: review.updated,
            ...(lookup.version !== undefined ? { version: lookup.version } : {}),
          })
        }
        versions.set(review.id, lookup?.version)
      }),
    )
    return versions
  }
}
