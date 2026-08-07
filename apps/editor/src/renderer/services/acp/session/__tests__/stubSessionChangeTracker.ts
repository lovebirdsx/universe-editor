/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for ISessionChangeTrackerService — records nothing, returns empty
 *  change lists. Lets AcpSessionService / AcpSession tests construct sessions
 *  without the real persisted-state machinery.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type {
  ISessionChangeTrackerService,
  RewindFileImpact,
  SessionFileChange,
} from '../sessionChangeTracker.js'
import type { DiffHunk } from '../sessionDiffReconstruct.js'

export interface StubSessionChangeRecord {
  readonly sessionId: string
  readonly path: string
  readonly toolCallId: string
  readonly hunks: readonly DiffHunk[]
  readonly created?: boolean
  readonly baseline?: string | null
}

export class StubSessionChangeTracker implements ISessionChangeTrackerService {
  declare readonly _serviceBrand: undefined
  readonly records: StubSessionChangeRecord[] = []
  readonly watchedRecords: { sessionId: string; path: string; baseline?: string | null }[] = []
  readonly dismissedWatched: { sessionId: string; path: string }[] = []
  readonly clearedSessions: string[] = []
  readonly restoredCalls: { sessionId: string; toolCallIds: readonly string[] }[] = []
  /** Overridable impact returned by previewRestore/restore. */
  restoreImpact: RewindFileImpact = { filesChanged: [], insertions: 0, deletions: 0 }
  private readonly _empty: IObservable<readonly SessionFileChange[]> = observableValue(
    'test.sessionChanges.empty',
    [],
  )
  initialize(): Promise<void> {
    return Promise.resolve()
  }
  record(
    sessionId: string,
    path: string,
    toolCallId: string,
    hunks: readonly DiffHunk[],
    opts?: { readonly created?: boolean; readonly baseline?: string | null },
  ): void {
    this.records.push({
      sessionId,
      path,
      toolCallId,
      hunks: [...hunks],
      ...(opts?.created !== undefined ? { created: opts.created } : {}),
      ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
    })
  }
  recordWatched(
    sessionId: string,
    path: string,
    opts?: { readonly baseline?: string | null },
  ): void {
    this.watchedRecords.push({
      sessionId,
      path,
      ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
    })
  }
  dismissWatched(sessionId: string, path: string): void {
    this.dismissedWatched.push({ sessionId, path })
  }
  changesFor(): IObservable<readonly SessionFileChange[]> {
    return this._empty
  }
  clear(sessionId: string): void {
    this.clearedSessions.push(sessionId)
  }
  previewRestore(sessionId: string, toolCallIds: readonly string[]): Promise<RewindFileImpact> {
    this.restoredCalls.push({ sessionId, toolCallIds: [...toolCallIds] })
    return Promise.resolve(this.restoreImpact)
  }
  restore(sessionId: string, toolCallIds: readonly string[]): Promise<RewindFileImpact> {
    this.restoredCalls.push({ sessionId, toolCallIds: [...toolCallIds] })
    return Promise.resolve(this.restoreImpact)
  }
}
