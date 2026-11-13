/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent trigger contracts. Two channels cooperate:
 *    - ITriggerMainService (forward, main impl, window-scoped wrapper tags the caller
 *      windowId): command palette / Sessions list talk to the single scheduler in main.
 *    - ITriggerRunHost (reverse, renderer impl): main asks the window that owns a
 *      trigger's workspace to start an automated session, and to report swarm events.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'
import type {
  TriggerEvent,
  TriggerPayloadValue,
  TriggerRunEnd,
  TriggerRunRequest,
  TriggerSummary,
} from '../triggers/types.js'

export interface ITriggerMainService {
  readonly _serviceBrand: undefined
  listTriggers(): Promise<readonly TriggerSummary[]>
  /** Fire a manual event now (works for any source type; `enabled` is not required). */
  runNow(triggerId: string): Promise<void>
  setPaused(triggerId: string, paused: boolean): Promise<void>
  setAllPaused(paused: boolean): Promise<void>
  /** Record the user's second confirmation for a bypass-class mode (bound to the config fingerprint). */
  confirmElevatedMode(triggerId: string): Promise<void>
  /** Record the user's second confirmation for automatic `swarm.approve` (bound to the config fingerprint). */
  confirmAutoApprove(triggerId: string): Promise<void>
  /** Create `triggers.json` with an example when absent; returns its file URI string. */
  ensureConfigFile(): Promise<string>
  /** Called by a window when its run reaches a terminal state. */
  reportRunEnd(end: TriggerRunEnd): Promise<void>
  /**
   * A window's swarm poller saw reviews that newly "need me". main applies the
   * persistent per-trigger dedupe, so duplicate reports from several windows are harmless.
   */
  reportSwarmNeedsAction(reviews: readonly SwarmNeedsActionReview[]): Promise<void>
  readonly onDidChangeTriggers: Event<readonly TriggerSummary[]>
}

export const ITriggerMainService = createDecorator<ITriggerMainService>('triggerMainService')

export interface SwarmNeedsActionReview {
  readonly reviewId: string
  readonly author: string
  readonly description: string
  readonly state: string
  /** Latest review version at detection time; approve requires it unchanged. */
  readonly version?: number
}

export interface ITriggerRunHost {
  readonly _serviceBrand: undefined
  /** Start the automated session and return once it exists (not when the run ends). */
  startRun(request: TriggerRunRequest): Promise<{ readonly sessionId: string }>
  /** Cancel a run's active turn (pause-all with cancel, or shutdown). */
  cancelRun(runId: string): Promise<void>
  /** Whether this window's workspace is trusted (runs are refused in untrusted workspaces). */
  isWorkspaceTrusted(): Promise<boolean>
}

export const ITriggerRunHost = createDecorator<ITriggerRunHost>('triggerRunHost')

export function swarmReviewEvent(
  triggerId: string,
  review: SwarmNeedsActionReview,
  now: number,
): TriggerEvent {
  const payload: Record<string, TriggerPayloadValue> = {
    reviewId: review.reviewId,
    author: review.author,
    description: review.description,
    state: review.state,
  }
  if (review.version !== undefined) payload['version'] = review.version
  return { triggerId, key: `swarm:${review.reviewId}`, payload, firedAt: now }
}
