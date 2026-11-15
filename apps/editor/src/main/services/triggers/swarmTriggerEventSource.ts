/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm "Needs My Action" event source. Kept outside triggerEventSources.ts so
 *  generic trigger core never imports Swarm types or knows the review schema.
 *--------------------------------------------------------------------------------------------*/

import type { TriggerPayloadValue } from '../../../shared/triggers/types.js'
import {
  SWARM_TRIGGER_EVENT_NAME,
  type SwarmNeedsActionReview,
} from '../../../shared/ipc/triggerService.js'
import type { TriggerEventSource, TriggerEventSourceItem } from './triggerEventSources.js'

export { SWARM_TRIGGER_EVENT_NAME }

function isReview(value: unknown): value is SwarmNeedsActionReview {
  if (typeof value !== 'object' || value === null) return false
  const review = value as Partial<SwarmNeedsActionReview>
  return (
    typeof review.reviewId === 'string' &&
    review.reviewId.length > 0 &&
    typeof review.author === 'string' &&
    typeof review.description === 'string' &&
    typeof review.state === 'string' &&
    (review.swarmUrl === undefined || typeof review.swarmUrl === 'string') &&
    (review.swarmApiVersion === undefined || typeof review.swarmApiVersion === 'string')
  )
}

export function createSwarmTriggerEventSource(): TriggerEventSource {
  return {
    eventName: SWARM_TRIGGER_EVENT_NAME,
    normalize(item: unknown): TriggerEventSourceItem | undefined {
      if (!isReview(item)) return undefined
      const payload: Record<string, TriggerPayloadValue> = {
        reviewId: item.reviewId,
        author: item.author,
        description: item.description,
        state: item.state,
      }
      if (item.swarmUrl !== undefined) payload['swarmUrl'] = item.swarmUrl
      if (item.swarmApiVersion !== undefined) payload['swarmApiVersion'] = item.swarmApiVersion
      return { key: `swarm:${item.reviewId}`, payload }
    },
  }
}
