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
  TriggerRunFilter,
  TriggerRunHistoryEntry,
  TriggerRunReportReadResult,
  TriggerRunRequest,
  TriggerSummary,
  TriggerWorkspaceSummary,
} from '../triggers/types.js'

/** Every command argument is a composite workspace + trigger key, never a bare id. */
export interface ITriggerMainService {
  readonly _serviceBrand: undefined
  listTriggers(): Promise<readonly TriggerSummary[]>
  /** Registered workspaces; `workspace` is a workspace URI string, not a bare path. */
  listWorkspaces(): Promise<readonly TriggerWorkspaceSummary[]>
  /** Machine-local run directory (`<userData>/triggers/runs`); only local runs' reports live there. */
  getRunsDir(): Promise<string>
  /** Apply the `triggers.maxConcurrentRuns` setting change without restarting main. */
  setMaxConcurrentRuns(limit: number): Promise<void>
  /** Fire a manual event now (works for any source type; `enabled` is not required). */
  runNow(triggerKey: string): Promise<void>
  setPaused(triggerKey: string, paused: boolean): Promise<void>
  setAllPaused(paused: boolean): Promise<void>
  /**
   * Record the user's one-time confirmation of a workspace-defined trigger, the
   * only local gate (it also covers a bypass-class mode). Bound to the config
   * fingerprint; editing the definition invalidates it. `fingerprint` is the one
   * shown in the confirmation dialog — main rejects the call when the definition
   * changed in the meantime, so an unseen definition is never confirmed.
   */
  confirmActivation(triggerKey: string, fingerprint: string): Promise<void>
  /**
   * Create `<workspace>/.universe-editor/triggers.json` with an example when absent,
   * register the workspace for background scheduling and return the file URI string.
   * `workspaceFolder` is the calling window's workspace URI string (`URI.toString()`);
   * main cannot infer it. Local `file:` and `remote-ssh:` workspaces are accepted;
   * a remote workspace must be connected.
   */
  ensureConfigFile(workspaceFolder?: string): Promise<string>
  /** Stop watching a registered workspace (URI string) and drop its queued events. */
  removeWorkspace(workspace: string): Promise<void>
  /** Called by a window when its run reaches a terminal state. */
  reportRunEnd(end: TriggerRunEnd): Promise<void>
  /**
   * Machine-local run history (`<userData>/triggers/history.jsonl`), newest first.
   * Malformed lines (hand-edited file) are skipped; `limit` defaults to 100, max 500.
   */
  listRuns(filter?: TriggerRunFilter): Promise<readonly TriggerRunHistoryEntry[]>
  /**
   * Read one run's `report.md` by run id. The file name and directory are
   * rebuilt in main; callers never pass a path. `authority` selects the remote
   * host whose run directory holds the report; it never triggers a connection.
   */
  readRunReport(runId: string, authority?: string): Promise<TriggerRunReportReadResult>
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
  /** Configured Swarm base URL, handed to the agent so its `swarm.mjs` calls hit the same server. */
  readonly swarmUrl?: string
  /** Configured Swarm REST API version segment, so the agent's calls match the same endpoint set. */
  readonly swarmApiVersion?: string
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
  if (review.swarmUrl !== undefined) payload['swarmUrl'] = review.swarmUrl
  if (review.swarmApiVersion !== undefined) payload['swarmApiVersion'] = review.swarmApiVersion
  return { triggerId, key: `swarm:${review.reviewId}`, payload, firedAt: now }
}
