/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent trigger contracts. Two channels cooperate:
 *    - ITriggerMainService (forward, app-singleton implementation in main): command
 *      palette / Sessions list / the window's TriggerRunHost talk to the single
 *      scheduler. Each window gets its own IPC channel, but the service instance is
 *      shared and calls are not tagged with the caller's window id; the renderer
 *      identifies itself where main needs it (workspace URI).
 *    - ITriggerRunHost (reverse, renderer impl): main asks the window that owns a
 *      trigger's workspace to start an automated session, and to report swarm events.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'
import type {
  TriggerPayloadValue,
  TriggerRunEnd,
  TriggerRunFilter,
  TriggerRunHistoryEntry,
  TriggerRunReportReadResult,
  TriggerRunRequest,
  TriggerSummary,
  TriggerWorkspaceSummary,
} from '../triggers/types.js'

/** Read-only projections of the trigger catalog and run history. */
export interface ITriggerQueryService {
  listTriggers(): Promise<readonly TriggerSummary[]>
  /** Registered workspaces; `workspace` is a workspace URI string, not a bare path. */
  listWorkspaces(): Promise<readonly TriggerWorkspaceSummary[]>
  /** Machine-local run directory (`<userData>/triggers/runs`); only local runs' reports live there. */
  getRunsDir(): Promise<string>
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
  readonly onDidChangeTriggers: Event<readonly TriggerSummary[]>
}

/** Renderer-supplied event for a manual run; main re-validates every field. */
export interface TriggerManualEvent {
  readonly payload: Readonly<Record<string, TriggerPayloadValue>>
  /** Poll item dedupe key (`poll:<id>`); consumed only for poll sources. */
  readonly sourceKey?: string
}

export type TriggerPollPreviewUnavailableReason =
  | 'all-paused'
  | 'offline'
  | 'needs-confirmation'
  | 'window-missing'
  | 'workspace-not-trusted'
  | 'poll-in-progress'
  | 'poll-failed'
  | 'poll-skipped'

export interface TriggerPollPreviewItem {
  /** `poll:<id>`; also the QuickPick id and the {@link TriggerManualEvent.sourceKey}. */
  readonly key: string
  /** `payload[keyField]` as text, falling back to the raw item key. */
  readonly value: string
  /** `payload.title` when it is a string. */
  readonly title?: string
  readonly payload: Readonly<Record<string, TriggerPayloadValue>>
  readonly processed: boolean
}

export type TriggerPollPreview =
  | { readonly kind: 'ok'; readonly items: readonly TriggerPollPreviewItem[] }
  | {
      readonly kind: 'unavailable'
      readonly reason: TriggerPollPreviewUnavailableReason
      /** Diagnostic text (raw poll error / transport reason); never shown as-is. */
      readonly detail?: string
    }
  | { readonly kind: 'unsupported' }

/** User-initiated control-plane commands (pause / activation / manual runs). */
export interface ITriggerControlService {
  /** Apply the `triggers.maxConcurrentRuns` setting change without restarting main. */
  setMaxConcurrentRuns(limit: number): Promise<void>
  /**
   * Fire a manual event now (works for any source type; `enabled` is not required).
   * For poll sources `event.sourceKey` is also marked processed so the next poll
   * does not consume the same item again.
   */
  runNow(triggerKey: string, event?: TriggerManualEvent): Promise<void>
  /**
   * Run one read-only poll fetch so a manual run can pick an item. Does not write
   * baseline / dedupe / failure state; the chosen item is consumed by `runNow`.
   */
  previewPollEvents(triggerKey: string): Promise<TriggerPollPreview>
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
}

/**
 * Run lifecycle events reported by renderer windows. Every entry carries the
 * reporting window's workspace URI: main's forward channel cannot identify the caller.
 */
export interface ITriggerRunEventService {
  /**
   * Acknowledge that this window's `TriggerRunHost` reverse channel is actually
   * served. Main holds a proxy from window creation, before the renderer registers
   * the handler, so runs are only routed to acknowledged windows. `workspaceFolder`
   * is the window's current workspace URI string; main cannot infer the caller.
   */
  markHostReady(workspaceFolder: string): Promise<void>
  /** Called by a window when its run reaches a terminal state. */
  reportRunEnd(end: TriggerRunEnd): Promise<void>
  /**
   * Generic event-source report: `items` are the full list a window currently sees
   * for `eventName`. Main maps each item through the registered event source (key
   * extraction + payload shape), applies the persistent per-trigger dedupe and the
   * first-report baseline, and scopes everything to `workspaceUri`.
   */
  reportTriggerEvents(
    eventName: string,
    items: readonly unknown[],
    workspaceUri: string,
  ): Promise<void>
}

/** Workspace catalog lifecycle (create / rescan / remove the triggers.json). */
export interface ITriggerWorkspaceService {
  /**
   * Create `<workspace>/.universe-editor/triggers.json` with an example when absent,
   * register the workspace for background scheduling and return the file URI string.
   * `workspaceFolder` is the calling window's workspace URI string (`URI.toString()`);
   * main cannot infer it. Local `file:` and `remote-ssh:` workspaces are accepted;
   * a remote workspace must be connected.
   */
  ensureConfigFile(workspaceFolder?: string): Promise<string>
  /**
   * Re-run discovery for the calling window's workspace (URI string). Idempotent
   * and read-only: a missing triggers.json is skipped, never created or overwritten.
   * A remote workspace that is not connected is deferred, not connected implicitly.
   */
  rescanWorkspace(workspaceFolder: string): Promise<void>
  /** Stop watching a registered workspace (URI string) and drop its queued events. */
  removeWorkspace(workspace: string): Promise<void>
}

/**
 * Composition consumed by renderer windows; main implements it as a singleton.
 * Every command argument is a composite workspace + trigger key, never a bare id.
 */
export interface ITriggerMainService
  extends
    ITriggerQueryService,
    ITriggerControlService,
    ITriggerRunEventService,
    ITriggerWorkspaceService {
  readonly _serviceBrand: undefined
}

export const ITriggerMainService = createDecorator<ITriggerMainService>('triggerMainService')

export interface ITriggerRunHost {
  readonly _serviceBrand: undefined
  /** Start the automated session and return once it exists (not when the run ends). */
  startRun(request: TriggerRunRequest): Promise<{ readonly sessionId: string }>
  /**
   * Cancel a run's active turn (screen watchdog / app shutdown). Pausing never
   * cancels active runs; `setAllPaused` only stops new ones from starting.
   */
  cancelRun(runId: string): Promise<void>
  /**
   * Whether `workspace` (URI string) is trusted on this machine. Judged by the
   * trigger's workspace, not by whatever folder the window currently shows.
   */
  isWorkspaceTrusted(workspace: string): Promise<boolean>
}

export const ITriggerRunHost = createDecorator<ITriggerRunHost>('triggerRunHost')
