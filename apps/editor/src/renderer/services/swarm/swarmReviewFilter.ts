/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure filtering for the Swarm Reviews list groups. Keeps the view component thin:
 *  the "Needs My Action" author/approvable filters and the "Authored by Me"
 *  hide-approved toggle are all decided here from plain data (reviews + config +
 *  the loaded transitions map), so they can be unit-tested without React.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '@universe-editor/platform'
import type { SwarmReviewDto, SwarmTransitionDto } from '@universe-editor/extensions-common'

/** Settings keys (persisted to settings.json under `perforce.swarm.*`). */
export const SwarmFilterConfigKeys = {
  /** Only show needs-action reviews whose author is in this set (empty = all). */
  needsActionAuthors: 'perforce.swarm.needsActionAuthors',
  /** Only show needs-action reviews the current user can currently approve. */
  needsActionApprovableOnly: 'perforce.swarm.needsActionApprovableOnly',
  /** Hide approved reviews from the "Authored by Me" group. */
  authoredHideApproved: 'perforce.swarm.authoredHideApproved',
} as const

export interface SwarmReviewFilterConfig {
  needsActionAuthors: readonly string[]
  needsActionApprovableOnly: boolean
  authoredHideApproved: boolean
}

/** Snapshot the three persisted list-filter settings from configuration. Shared by
 *  SwarmReviewsView and the background review-notification contribution so both
 *  compute the "final displayed" list identically. */
export function readSwarmFilterConfig(
  configuration: IConfigurationService,
): SwarmReviewFilterConfig {
  return {
    needsActionAuthors: configuration.get<string[]>(SwarmFilterConfigKeys.needsActionAuthors) ?? [],
    needsActionApprovableOnly:
      configuration.get<boolean>(SwarmFilterConfigKeys.needsActionApprovableOnly) ?? false,
    authoredHideApproved:
      configuration.get<boolean>(SwarmFilterConfigKeys.authoredHideApproved) ?? true,
  }
}

/** Whether the loaded transitions permit an Approve action (drives the blue check
 *  and the "approvable only" filter). Kept here so the view and the filter agree. */
export function canApproveReview(transitions: readonly SwarmTransitionDto[] | undefined): boolean {
  return (
    transitions?.some(
      (transition) => transition.state === 'approved' || transition.state === 'approved:commit',
    ) ?? false
  )
}

/**
 * Filter the "Needs My Action" group by the configured author set and the
 * approvable-only toggle. When approvable-only is on but a review's transitions
 * have not loaded yet, it is kept (optimistic) and converges once transitions
 * arrive — matching how the view lazily loads them.
 */
export function filterNeedsAction(
  reviews: readonly SwarmReviewDto[],
  config: SwarmReviewFilterConfig,
  transitions: Readonly<Record<string, readonly SwarmTransitionDto[]>>,
): SwarmReviewDto[] {
  const authors = new Set(config.needsActionAuthors)
  return reviews.filter((review) => {
    if (authors.size > 0 && !authors.has(review.author)) return false
    if (config.needsActionApprovableOnly) {
      const loaded = transitions[review.id]
      if (loaded !== undefined && !canApproveReview(loaded)) return false
    }
    return true
  })
}

/** Filter the "Authored by Me" group by the hide-approved toggle. */
export function filterAuthored(
  reviews: readonly SwarmReviewDto[],
  config: SwarmReviewFilterConfig,
): SwarmReviewDto[] {
  if (!config.authoredHideApproved) return [...reviews]
  return reviews.filter((review) => review.state !== 'approved')
}
