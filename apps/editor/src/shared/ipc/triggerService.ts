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
  TriggerRunReportReadResult,
  TriggerRunRequest,
  TriggerSummary,
  TriggerWorkspaceSummary,
} from '../triggers/types.js'

/** Every command argument is a composite workspace + trigger key, never a bare id. */
export interface ITriggerMainService {
  readonly _serviceBrand: undefined
  listTriggers(): Promise<readonly TriggerSummary[]>
  listWorkspaces(): Promise<readonly TriggerWorkspaceSummary[]>
  /** Machine-local run directory (`<userData>/triggers/runs`); reports live there. */
  getRunsDir(): Promise<string>
  /** Apply the `triggers.maxConcurrentRuns` setting change without restarting main. */
  setMaxConcurrentRuns(limit: number): Promise<void>
  /** Fire a manual event now (works for any source type; `enabled` is not required). */
  runNow(triggerKey: string): Promise<void>
  setPaused(triggerKey: string, paused: boolean): Promise<void>
  setAllPaused(paused: boolean): Promise<void>
  /**
   * Record the user's one-time confirmation of a workspace-defined trigger
   * (bound to the config fingerprint; editing the definition invalidates it).
   */
  confirmActivation(triggerKey: string): Promise<void>
  /** Record the user's second confirmation for a bypass-class mode (bound to the config fingerprint). */
  confirmElevatedMode(triggerKey: string): Promise<void>
  /** Record the user's second confirmation for automatic `swarm.approve` (bound to the config fingerprint). */
  confirmAutoApprove(triggerKey: string): Promise<void>
  /**
   * Create `<workspace>/.universe-editor/triggers.json` with an example when absent,
   * register the workspace for background scheduling and return the file URI string.
   * The workspace comes from the calling window (main cannot infer it).
   */
  ensureConfigFile(workspaceFolder?: string): Promise<string>
  /** Stop watching a registered workspace and drop its queued events. */
  removeWorkspace(workspace: string): Promise<void>
  /** Called by a window when its run reaches a terminal state. */
  reportRunEnd(end: TriggerRunEnd): Promise<void>
  /**
   * Read one run's `report.md` by run id. The file name and directory are
   * rebuilt in main; callers never pass a path.
   */
  readRunReport(runId: string): Promise<TriggerRunReportReadResult>
  /**
   * The full current "needs me" review list seen by a window's swarm poller (same
   * filter as the sidebar notification). main applies the persistent per-trigger
   * dedupe and the first-report baseline, so repeated or multi-window reports are harmless
   * and reviews that appeared while the editor was closed still fire after a restart.
   * `workspaceFolder` is the reporting window's workspace URI string (`URI.toString()`);
   * main scopes the report to that workspace's triggers and rejects an unresolvable
   * URI. A window without a folder must not report at all.
   */
  reportSwarmNeedsAction(
    reviews: readonly SwarmNeedsActionReview[],
    workspaceFolder: string,
  ): Promise<void>
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
  /**
   * Last-updated stamp (Unix ms) at detection time. Swarm does NOT bump the
   * version when an unapproved review is re-shelved (it only moves on approve),
   * so the version alone cannot detect the author pushing new changes; approve
   * requires this stamp unchanged too.
   */
  readonly updated?: number
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
  if (review.updated !== undefined) payload['updated'] = review.updated
  return { triggerId, key: `swarm:${review.reviewId}`, payload, firedAt: now }
}
