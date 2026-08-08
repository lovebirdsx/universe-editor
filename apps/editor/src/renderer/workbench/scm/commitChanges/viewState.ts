/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Module-level store for the Commit Changes sidebar view: the
 *  `_workbench.showCommitChanges` bridge action writes the payload here and the
 *  view (a separate React subtree, possibly not yet mounted) consumes it.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'

const _payload = observableValue<ShowCommitChangesPayload | null>('commitChanges.payload', null)
const _tick = observableValue<number>('commitChanges.tick', 0)

export const commitChangesViewState = {
  payload: _payload as IObservable<ShowCommitChangesPayload | null>,
  /** Monotonic counter bumped by every show() — same-commit re-triggers must
   *  still re-reveal / reset the tree, so identity is tick, not payload. */
  tick: _tick as IObservable<number>,
  show(p: ShowCommitChangesPayload): void {
    _payload.set(p, undefined)
    _tick.set(_tick.get() + 1, undefined)
  },
  clear(): void {
    _payload.set(null, undefined)
  },
  _resetForTests(): void {
    _payload.set(null, undefined)
    _tick.set(0, undefined)
  },
}
