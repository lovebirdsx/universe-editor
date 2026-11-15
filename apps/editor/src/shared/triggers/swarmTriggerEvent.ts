/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm "Needs My Action" event contract, shared by the renderer reporter and
 *  main's Swarm event source. Kept out of the trigger IPC contract on purpose.
 *--------------------------------------------------------------------------------------------*/

export const SWARM_TRIGGER_EVENT_NAME = 'swarm.reviewNeedsAction'

export interface SwarmNeedsActionReview {
  readonly reviewId: string
  readonly author: string
  readonly description: string
  readonly state: string
  /** Configured Swarm base URL, handed to the agent so its `swarm.mjs` calls hit the same server. */
  readonly swarmUrl?: string
  /** Configured Swarm REST API version segment, so the agent's calls match the same endpoint set. */
  readonly swarmApiVersion?: string
}
