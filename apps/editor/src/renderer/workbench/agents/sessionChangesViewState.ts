/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Session Changes viewlet. The title toolbar lives in
 *  a separate React subtree from the body, so the view mode (list/tree) is held
 *  here as a module-level observable rather than in component state. Persistence
 *  is driven by SessionChangesView (it owns the IStorageService dependency).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'

export type SessionChangesViewMode = 'list' | 'tree'

const _viewMode = observableValue<SessionChangesViewMode>('acp.sessionChanges.viewMode', 'list')

export const sessionChangesViewState = {
  viewMode: _viewMode as IObservable<SessionChangesViewMode>,
  setViewMode(mode: SessionChangesViewMode): void {
    _viewMode.set(mode, undefined)
  },
}
