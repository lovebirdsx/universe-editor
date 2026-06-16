/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for ISessionChangeTrackerService — records nothing, returns empty
 *  change lists. Lets AcpSessionService / AcpSession tests construct sessions
 *  without the real persisted-state machinery.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ISessionChangeTrackerService, SessionFileChange } from '../sessionChangeTracker.js'

export class StubSessionChangeTracker implements ISessionChangeTrackerService {
  declare readonly _serviceBrand: undefined
  private readonly _empty: IObservable<readonly SessionFileChange[]> = observableValue(
    'test.sessionChanges.empty',
    [],
  )
  initialize(): Promise<void> {
    return Promise.resolve()
  }
  record(): void {}
  changesFor(): IObservable<readonly SessionFileChange[]> {
    return this._empty
  }
  clear(): void {}
}
