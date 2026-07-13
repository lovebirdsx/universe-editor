/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm renderer actions: focus the Swarm Reviews view, and open a review detail
 *  tab by id (used by the status bar + deep links). Both are renderer Action2s —
 *  their command ids must NOT appear in the perforce extension's package.json
 *  `commands` array (that would shadow them with a no-op host command; see memory
 *  `renderer-action-shadowed-by-extension-command-decl`).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  ILayoutService,
  IViewsService,
  PartId,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { SwarmReviewEditorInput } from '../services/editor/SwarmReviewEditorInput.js'

/** Focus (and reveal) the Swarm Reviews view container in the primary side bar. */
function revealSwarmContainer(accessor: ServicesAccessor): void {
  const layout = accessor.get(ILayoutService)
  if (!layout.getVisible(PartId.SideBar)) layout.setVisible(PartId.SideBar, true)
  accessor.get(IViewsService).openViewContainer('workbench.view.swarm')
}

export class OpenSwarmReviewsAction extends Action2 {
  static readonly ID = 'swarm.openReviews'

  constructor() {
    super({
      id: OpenSwarmReviewsAction.ID,
      title: 'Show Swarm Reviews',
      category: 'Swarm',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    revealSwarmContainer(accessor)
  }
}

export class OpenSwarmReviewAction extends Action2 {
  static readonly ID = 'swarm.openReview'

  constructor() {
    super({
      id: OpenSwarmReviewAction.ID,
      title: 'Open Swarm Review',
      category: 'Swarm',
    })
  }

  override async run(accessor: ServicesAccessor, reviewId?: unknown): Promise<void> {
    const id = typeof reviewId === 'string' ? reviewId : String(reviewId ?? '')
    if (!id) return
    await accessor.get(IEditorService).openEditor(new SwarmReviewEditorInput(id))
  }
}

/**
 * Host-invokable twin of {@link OpenSwarmReviewAction}. The perforce extension
 * calls this (`_workbench.*` is the only namespace the host may invoke back in
 * the renderer) after creating a review, to open its detail tab. Kept separate so
 * the shadowing guardrail is respected: neither id appears in the extension's
 * package.json `commands`.
 */
export class WorkbenchOpenSwarmReviewAction extends Action2 {
  static readonly ID = '_workbench.openSwarmReview'

  constructor() {
    super({ id: WorkbenchOpenSwarmReviewAction.ID, title: 'Open Swarm Review' })
  }

  override async run(accessor: ServicesAccessor, reviewId?: unknown): Promise<void> {
    const id = typeof reviewId === 'string' ? reviewId : String(reviewId ?? '')
    if (!id) return
    await accessor.get(IEditorService).openEditor(new SwarmReviewEditorInput(id))
  }
}

/**
 * Host-invokable twin of {@link OpenSwarmReviewsAction} — focuses the Swarm
 * Reviews view. Called by the status-bar notification's "Open" button when
 * several reviews became actionable at once.
 */
export class WorkbenchOpenSwarmReviewsAction extends Action2 {
  static readonly ID = '_workbench.openSwarmReviews'

  constructor() {
    super({ id: WorkbenchOpenSwarmReviewsAction.ID, title: 'Show Swarm Reviews' })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    revealSwarmContainer(accessor)
  }
}
