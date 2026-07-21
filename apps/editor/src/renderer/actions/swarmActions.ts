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
  IQuickInputService,
  IViewsService,
  MenuId,
  PartId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { SwarmReviewEditorInput } from '../services/editor/SwarmReviewEditorInput.js'
import { requestSwarmReviewsRefresh } from '../services/swarm/swarmViewState.js'
import { driveSwarmNotificationTick } from '../services/swarm/swarmNotificationTick.js'

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
 * Prompt for a review id and open its detail tab. Entry points: the Swarm Reviews
 * view title bar (a go-to-file icon) and the command palette. A renderer Action2 —
 * its id must NOT appear in the extension's package.json `commands`.
 */
export class OpenSwarmReviewByIdAction extends Action2 {
  static readonly ID = 'swarm.openReviewById'

  constructor() {
    super({
      id: OpenSwarmReviewByIdAction.ID,
      title: 'Open Swarm Review by ID…',
      category: 'Swarm',
      f1: true,
      icon: 'go-to-file',
      menu: [
        {
          id: MenuId.ViewTitle,
          when: 'view == workbench.view.swarm.reviews',
          group: 'navigation',
          order: 0,
        },
      ],
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const editorService = accessor.get(IEditorService)
    const entered = await quickInput.input({
      prompt: localize('swarm.openById.prompt', 'Enter a Swarm review id to open'),
      placeholder: localize('swarm.openById.placeholder', 'Review id, e.g. 8113801'),
      validateInput: (value: string) => {
        const trimmed = value.trim()
        if (!trimmed) return undefined
        return /^\d+$/.test(trimmed)
          ? undefined
          : localize('swarm.openById.invalid', 'Enter a numeric review id.')
      },
    })
    const id = entered?.trim()
    if (!id || !/^\d+$/.test(id)) return
    await editorService.openEditor(new SwarmReviewEditorInput(id))
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

/**
 * Host-invokable poll tick for the new-review desktop notification. The poll timer
 * lives in the perforce extension host (a Node child process Chromium never
 * background-throttles) so notifications keep firing while the window sits in the
 * background — the renderer's own setInterval freezes there, which is why
 * notifications never fired overnight. Routes to the live contribution's refresh()
 * via the module-level tick seam (this Action2 is stateless). Never appears in the
 * extension's package.json `commands` — it is a host→renderer `_workbench.*` lane.
 */
export class WorkbenchSwarmPollTickAction extends Action2 {
  static readonly ID = '_workbench.swarmPollTick'

  constructor() {
    super({ id: WorkbenchSwarmPollTickAction.ID, title: 'Swarm Poll Tick' })
  }

  override async run(): Promise<void> {
    await driveSwarmNotificationTick()
  }
}

/**
 * Manual refresh for the Swarm Reviews list, shown as an icon in the view title
 * bar. Fires the refresh bus the mounted view subscribes to (it owns the fetch +
 * transitions cache), so this action stays free of any HTTP or service lookups.
 */
export class RefreshSwarmReviewsAction extends Action2 {
  static readonly ID = 'swarm.refreshReviews'

  constructor() {
    super({
      id: RefreshSwarmReviewsAction.ID,
      title: 'Refresh Swarm Reviews',
      category: 'Swarm',
      icon: 'refresh',
      menu: [
        {
          id: MenuId.ViewTitle,
          when: 'view == workbench.view.swarm.reviews',
          group: 'navigation',
          order: 1,
        },
      ],
    })
  }

  override run(): void {
    requestSwarmReviewsRefresh()
  }
}
