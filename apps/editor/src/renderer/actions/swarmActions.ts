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
  IViewDescriptorService,
  IViewsService,
  KeybindingWeight,
  MenuId,
  PartId,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { SwarmReviewEditorInput } from '../services/editor/SwarmReviewEditorInput.js'
import { requestSwarmReviewsRefresh } from '../services/swarm/swarmViewState.js'
import { driveSwarmNotificationTick } from '../services/swarm/swarmNotificationTick.js'

const CATEGORY = localize2('command.category.swarm', 'Swarm')

export const SWARM_CONTAINER_ID = 'workbench.view.swarm'

export const SWARM_REVIEWS_VIEW_ID = 'workbench.view.swarm.reviews'

/** View id of the Swarm Changes view; shared by the dynamic view registration
 *  (SwarmViewContribution), the view component and the focus commands. Lives
 *  here rather than in the view component so neither side imports the other's
 *  React tree — same seam as SESSION_CHANGES_VIEW_ID. */
export const SWARM_CHANGES_VIEW_ID = 'workbench.view.swarm.changes'

/** Keybinding scope for the Swarm Reviews tree: the root `focusedView` context
 *  key (seeded by FocusContextKeyContribution from the DOM's data-view-id). */
const SWARM_REVIEWS_FOCUS_WHEN = `focusedView == '${SWARM_REVIEWS_VIEW_ID}'`

/** Focus (and reveal) the Swarm Reviews view container in the primary side bar. */
function revealSwarmContainer(accessor: ServicesAccessor): void {
  const layout = accessor.get(ILayoutService)
  if (!layout.getVisible(PartId.SideBar)) layout.setVisible(PartId.SideBar, true)
  // focusView (not openViewContainer) so re-running this while the container is
  // already the active one still moves keyboard focus into the view.
  void layout.focusView(SWARM_REVIEWS_VIEW_ID, { source: 'command' })
}

export class OpenSwarmReviewsAction extends Action2 {
  static readonly ID = 'swarm.openReviews'

  constructor() {
    super({
      id: OpenSwarmReviewsAction.ID,
      title: localize2('action.swarm.showReviews', 'Show Swarm Reviews'),
      category: CATEGORY,
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
      title: localize2('action.swarm.openReview', 'Open Swarm Review'),
      category: CATEGORY,
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
      title: localize2('action.swarm.openReviewById', 'Open Swarm Review by ID…'),
      category: CATEGORY,
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
      placeholder: localize('swarm.openById.placeholder', 'Review id, e.g. 100801'),
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
    super({
      id: WorkbenchOpenSwarmReviewAction.ID,
      title: localize2('action.swarm.openReview', 'Open Swarm Review'),
    })
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
    super({
      id: WorkbenchOpenSwarmReviewsAction.ID,
      title: localize2('action.swarm.showReviews', 'Show Swarm Reviews'),
    })
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
    super({
      id: WorkbenchSwarmPollTickAction.ID,
      title: localize2('action.swarm.pollTick', 'Swarm Poll Tick'),
    })
  }

  override async run(): Promise<void> {
    await driveSwarmNotificationTick()
  }
}

/**
 * Manual refresh for the Swarm Reviews list, shown as an icon in the view title
 * bar. Fires the refresh bus the mounted view subscribes to (it owns the fetch +
 * transitions cache), so this action stays free of any HTTP or service lookups.
 * The returned promise settles when the view's reload does — the title button
 * holds its disabled/spinning state for exactly that long.
 */
export class RefreshSwarmReviewsAction extends Action2 {
  static readonly ID = 'swarm.refreshReviews'

  constructor() {
    super({
      id: RefreshSwarmReviewsAction.ID,
      title: localize2('action.swarm.refreshReviews', 'Refresh Swarm Reviews'),
      category: CATEGORY,
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

  override async run(): Promise<void> {
    await requestSwarmReviewsRefresh()
  }
}

/** Reveal the Swarm container, expand the Swarm Changes view and move DOM focus
 *  into its file tree. Shared by the palette command and the Ctrl+Enter jump. */
async function focusSwarmChangesView(accessor: ServicesAccessor): Promise<void> {
  // Snapshot every service synchronously — the accessor dies past the first await.
  const layoutService = accessor.get(ILayoutService)
  const viewsService = accessor.get(IViewsService)
  const viewDescriptorService = accessor.get(IViewDescriptorService)

  if (!layoutService.getVisible(PartId.SideBar)) layoutService.setVisible(PartId.SideBar, true)
  viewsService.openViewContainer(SWARM_CONTAINER_ID)
  viewDescriptorService.setViewCollapsed(SWARM_CHANGES_VIEW_ID, false)
  await layoutService.focusView(SWARM_CHANGES_VIEW_ID, { source: 'command' })
}

/**
 * Focus the Swarm Changes view. No default keybinding — VSCode assigns none to
 * secondary views either; the command palette (f1) finds it. Mirrors
 * FocusCommitChangesAction / FocusSessionChangesAction.
 */
export class FocusSwarmChangesAction extends Action2 {
  static readonly ID = 'workbench.view.swarm.changes.focus'

  constructor() {
    super({
      id: FocusSwarmChangesAction.ID,
      title: localize2('action.swarmChanges.focus', 'Focus on Swarm Changes View'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await focusSwarmChangesView(accessor)
  }
}

/**
 * Ctrl+Enter from the Swarm Reviews tree hands keyboard focus to the Swarm
 * Changes file tree — the keyboard twin of "I picked a review, now let me walk
 * its files". Scoped to the reviews view through the root `focusedView` key; the
 * weight must beat any global Ctrl+Enter binding (see memory
 * `keybinding-when-not-priority-weight-wins`). The Tree ignores modifier-key
 * combos outright (Tree.tsx's `if (e.altKey || e.ctrlKey || e.metaKey) return`),
 * so the event reaches the global keybinding handler unconsumed.
 */
export class JumpToSwarmChangesAction extends Action2 {
  static readonly ID = 'swarm.jumpToChanges'

  constructor() {
    super({
      id: JumpToSwarmChangesAction.ID,
      title: localize2('action.swarm.jumpToChanges', 'Go to Swarm Changes'),
      category: CATEGORY,
      keybinding: {
        primary: 'ctrl+enter',
        when: SWARM_REVIEWS_FOCUS_WHEN,
        weight: KeybindingWeight.WorkbenchContrib + 50,
      },
      precondition: SWARM_REVIEWS_FOCUS_WHEN,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await focusSwarmChangesView(accessor)
  }
}
