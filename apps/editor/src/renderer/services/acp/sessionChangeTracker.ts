/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangeTrackerService — per-session, whole-file change tracking.
 *
 *  The agent reports each Edit/Write as a `structuredPatch` (hunks with line
 *  numbers) via `_meta.claudeCode.toolResponse`. We accumulate those hunks per
 *  (sessionId, path) in apply-order. To render a *whole-file* diff scoped to the
 *  session, we read the file's current on-disk content and run
 *  {@link reconstructBaseline} in reverse to recover the pre-session baseline —
 *  the agent writes directly to disk, so the renderer can never read the real
 *  pre-edit content otherwise.
 *
 *  Only the hunk batches are persisted (workspace-first via PersistedStateBase);
 *  baseline and current are always recomputed from disk so the store stays small
 *  and survives editor restarts / session resume.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  observableValue,
  registerSingleton,
  InstantiationType,
  URI,
  IFileService,
  IStorageService,
  IWorkspaceService,
  ITelemetryService,
  ILoggerService,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from './persistedStateBase.js'
import { reconstructBaseline, type DiffBatch, type DiffHunk } from './diff/reconstructBaseline.js'

export type SessionFileChangeStatus = 'added' | 'modified' | 'deleted' | 'degraded'

export interface SessionFileChange {
  readonly uri: URI
  readonly path: string
  readonly baseline: string
  readonly current: string
  readonly status: SessionFileChangeStatus
  /** Number of tool-call batches that touched this file. */
  readonly batchCount: number
}

export interface ISessionChangeTrackerService {
  readonly _serviceBrand: undefined
  /** Idempotent; main.tsx fire-and-forgets. */
  initialize(): Promise<void>
  /**
   * Record one Edit/Write tool call's hunks against a file. Re-delivered updates
   * for the same `toolCallId` replace the prior batch rather than duplicating.
   */
  record(sessionId: string, path: string, toolCallId: string, hunks: readonly DiffHunk[]): void
  /** Observable list of whole-file changes for a session (empty if none/unknown). */
  changesFor(sessionId: string): IObservable<readonly SessionFileChange[]>
  /** Drop all tracked changes for a session (e.g. on user-initiated clear). */
  clear(sessionId: string): void
}

export const ISessionChangeTrackerService = createDecorator<ISessionChangeTrackerService>(
  'sessionChangeTrackerService',
)

const STORAGE_KEY = 'acp.sessionChanges'
const SCHEMA_VERSION = 1

/** Persisted batches keyed by sessionId → path → ordered batches. */
type TrackerState = Map<string, Map<string, DiffBatch[]>>

interface PersistedShape {
  readonly schemaVersion: number
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string
    readonly files: ReadonlyArray<{ readonly path: string; readonly batches: readonly DiffBatch[] }>
  }>
}

export class SessionChangeTrackerService
  extends PersistedStateBase<TrackerState>
  implements ISessionChangeTrackerService
{
  declare readonly _serviceBrand: undefined

  /** Per-session observable lists, lazily created on first access. */
  private readonly _observables = new Map<
    string,
    ISettableObservable<readonly SessionFileChange[]>
  >()

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _files: IFileService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpSessionChanges',
      loggerName: 'ACP Session Changes',
      persistFailureEvent: 'acp.session_changes_persist_failed',
    })
  }

  // -- PersistedStateBase hooks ---------------------------------------

  protected _emptyState(): TrackerState {
    return new Map()
  }

  protected _serialize(state: TrackerState): PersistedShape {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessions: [...state.entries()].map(([sessionId, files]) => ({
        sessionId,
        files: [...files.entries()].map(([path, batches]) => ({ path, batches })),
      })),
    }
  }

  protected _deserialize(raw: unknown): TrackerState | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const shape = raw as Partial<PersistedShape>
    if (shape.schemaVersion !== SCHEMA_VERSION || !Array.isArray(shape.sessions)) return undefined
    const state: TrackerState = new Map()
    for (const s of shape.sessions) {
      const files = new Map<string, DiffBatch[]>()
      for (const f of s.files) files.set(f.path, [...f.batches])
      state.set(s.sessionId, files)
    }
    return state
  }

  protected _onStateReplaced(state: TrackerState): void {
    // Recompute every session that already has a live observable. Sessions
    // observed later recompute lazily on first `changesFor`.
    for (const sessionId of this._observables.keys()) {
      void this._recompute(sessionId, state.get(sessionId))
    }
  }

  // -- public API -----------------------------------------------------

  record(sessionId: string, path: string, toolCallId: string, hunks: readonly DiffHunk[]): void {
    if (hunks.length === 0) return
    let files = this._state.get(sessionId)
    if (!files) {
      files = new Map()
      this._state.set(sessionId, files)
    }
    const batches = files.get(path) ?? []
    const idx = batches.findIndex((b) => b.toolCallId === toolCallId)
    const batch: DiffBatch = { toolCallId, hunks: [...hunks] }
    if (idx >= 0) batches[idx] = batch
    else batches.push(batch)
    files.set(path, batches)
    this._scheduleWrite()
    void this._recompute(sessionId, files)
  }

  changesFor(sessionId: string): IObservable<readonly SessionFileChange[]> {
    let obs = this._observables.get(sessionId)
    if (!obs) {
      obs = observableValue<readonly SessionFileChange[]>(`acp.sessionChanges.${sessionId}`, [])
      this._observables.set(sessionId, obs)
      void this._recompute(sessionId, this._state.get(sessionId))
    }
    return obs
  }

  clear(sessionId: string): void {
    if (!this._state.delete(sessionId)) return
    this._scheduleWrite()
    this._observables.get(sessionId)?.set([], undefined)
  }

  // -- internals ------------------------------------------------------

  private async _recompute(
    sessionId: string,
    files: Map<string, DiffBatch[]> | undefined,
  ): Promise<void> {
    const obs = this._observables.get(sessionId)
    if (!obs) return
    if (!files || files.size === 0) {
      obs.set([], undefined)
      return
    }
    const changes = await Promise.all(
      [...files.entries()].map(([path, batches]) => this._buildChange(path, batches)),
    )
    obs.set(
      changes.filter((c): c is SessionFileChange => c !== undefined),
      undefined,
    )
  }

  private async _buildChange(
    path: string,
    batches: readonly DiffBatch[],
  ): Promise<SessionFileChange | undefined> {
    const uri = path.includes('://') ? URI.parse(path) : URI.file(path)
    let current = ''
    let existed = true
    try {
      current = await this._files.readFileText(uri)
    } catch {
      existed = false
    }
    const { baseline, degraded } = reconstructBaseline(current, batches)
    if (baseline === current && existed) return undefined
    const status: SessionFileChangeStatus = degraded
      ? 'degraded'
      : !existed
        ? 'deleted'
        : baseline === ''
          ? 'added'
          : 'modified'
    return { uri, path, baseline, current, status, batchCount: batches.length }
  }
}

registerSingleton(
  ISessionChangeTrackerService,
  SessionChangeTrackerService,
  InstantiationType.Delayed,
)
