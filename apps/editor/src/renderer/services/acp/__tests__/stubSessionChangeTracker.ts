/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for ISessionChangeTrackerService — records nothing, returns empty
 *  change lists. Lets AcpSessionService / AcpSession tests construct sessions
 *  without the real persisted-state machinery.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ISessionChangeTrackerService, SessionFileChange } from '../sessionChangeTracker.js'
import type { DiffHunk } from '../diff/reconstructBaseline.js'

export interface StubSessionChangeRecord {
  readonly sessionId: string
  readonly path: string
  readonly toolCallId: string
  readonly hunks: readonly DiffHunk[]
  readonly created?: boolean
}

export class StubSessionChangeTracker implements ISessionChangeTrackerService {
  declare readonly _serviceBrand: undefined
  readonly records: StubSessionChangeRecord[] = []
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
    created?: boolean,
  ): void {
    this.records.push({
      sessionId,
      path,
      toolCallId,
      hunks: [...hunks],
      ...(created !== undefined ? { created } : {}),
    })
  }
  changesFor(): IObservable<readonly SessionFileChange[]> {
    return this._empty
  }
  markDeleted(): void {}
  unmarkDeleted(): void {}
  clear(): void {}
}
