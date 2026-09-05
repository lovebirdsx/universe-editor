/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmChangesViewToolbar — title-bar actions of the Swarm Changes view:
 *  collapse/expand-all (tree mode only) plus the `…` overflow carrying the
 *  View as List / View as Tree toggle, both from the shared changesTree toolbar
 *  pieces. The toolbar renders in the SideBar header (a separate React subtree
 *  from the view body), so state travels through swarmChangesViewState.
 *--------------------------------------------------------------------------------------------*/

import { useObservable } from '../useService.js'
import {
  ChangesTreeCollapseExpandButtons,
  ChangesTreeViewModeOverflow,
} from '../changesTree/toolbar.js'
import { swarmChangesViewState } from './swarmChangesViewState.js'

export function SwarmChangesViewToolbar() {
  const viewMode = useObservable(swarmChangesViewState.viewMode)
  const reviewId = useObservable(swarmChangesViewState.selectedReviewId)

  if (reviewId === null) return null

  return (
    <>
      <ChangesTreeCollapseExpandButtons
        viewMode={viewMode}
        commandPrefix="swarmChanges"
        onCollapseAll={() => swarmChangesViewState.requestCollapseAll()}
        onExpandAll={() => swarmChangesViewState.requestExpandAll()}
      />
      <ChangesTreeViewModeOverflow
        viewMode={viewMode}
        onSetViewMode={(mode) => swarmChangesViewState.setViewMode(mode)}
      />
    </>
  )
}
