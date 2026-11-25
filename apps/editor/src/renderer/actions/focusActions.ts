/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Focus navigation Action2 definitions: F6 / Shift+F6 / dump focus state, and
 *  the spatial navigateLeft/Right/Up/Down across groups and parts.
 *
 *  Group-level focus (alt+0/9, ctrl+k arrows) and Escape-to-editor live in
 *  editorActions.ts. This file is for cross-Part navigation, driven by
 *  IFocusStackService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  GroupDirection,
  IContextKeyService,
  IEditorGroupsService,
  IFocusStackService,
  ILayoutService,
  PartId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  activateGroupAndFocus,
  type ActivateGroupFocusContext,
} from '../services/editor/activateGroupAndFocus.js'
import { focusGroupBody } from '../services/editor/editorFocus.js'
import { isPartFocusedInActiveDocument } from '../services/focus/partFocus.js'
import {
  findPartInDirection,
  type NavigateDirection,
  type PartRect,
} from '../services/focus/partDirection.js'
import {
  findWindowInDirection,
  offsetRectToScreen,
  windowScreenRect,
} from '../services/focus/windowDirection.js'
import {
  IWorkbenchWindowService,
  type IWorkbenchWindow,
} from '../services/windows/workbenchWindowService.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'

export class FocusNextPartAction extends Action2 {
  static readonly ID = 'workbench.action.focusNextPart'
  constructor() {
    super({
      id: FocusNextPartAction.ID,
      title: localize2('action.focusNextPart.title', 'Focus Next Part'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'f6', when: '!quickInputVisible' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const next = accessor.get(IFocusStackService).nextPart()
    if (next) await accessor.get(ILayoutService).focusPart(next, { source: 'command' })
  }
}

export class FocusPreviousPartAction extends Action2 {
  static readonly ID = 'workbench.action.focusPreviousPart'
  constructor() {
    super({
      id: FocusPreviousPartAction.ID,
      title: localize2('action.focusPreviousPart.title', 'Focus Previous Part'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'shift+f6', when: '!quickInputVisible' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const prev = accessor.get(IFocusStackService).previousPart()
    if (prev) await accessor.get(ILayoutService).focusPart(prev, { source: 'command' })
  }
}

const NAVIGABLE_PARTS: readonly PartId[] = [
  PartId.SideBar,
  PartId.EditorArea,
  PartId.Panel,
  PartId.SecondarySideBar,
]

const GROUP_DIRECTION: Record<NavigateDirection, GroupDirection> = {
  left: GroupDirection.Left,
  right: GroupDirection.Right,
  up: GroupDirection.Up,
  down: GroupDirection.Down,
}

function partRect(layout: ILayoutService, id: PartId): PartRect | undefined {
  if (!layout.getVisible(id)) return undefined
  const container = layout.getPart(id)?.getContainer() as Partial<HTMLElement> | undefined
  const rect = container?.getBoundingClientRect?.()
  // A collapsed part (maximized panel hides the editor) has no area to move into.
  if (rect === undefined || rect.width <= 0 || rect.height <= 0) return undefined
  return rect
}

/** Reveal a window's last-active editor group; an empty group still takes keyboard focus. */
function focusWindowGroup(win: IWorkbenchWindow, ctx: ActivateGroupFocusContext): void {
  const group = win.part.activeGroup
  activateGroupAndFocus(group, ctx)
  if (!group.activeEditor) focusGroupBody(ctx.contextKeyService, group.id)
}

/**
 * Visible main-window parts in screen coordinates. The direction origin already
 * lives in screen space, so candidates must use the TARGET window's origin — not
 * the source auxiliary window's.
 */
function screenPartCandidates(
  layout: ILayoutService,
  win: IWorkbenchWindow,
): { id: PartId; rect: PartRect }[] {
  const candidates: { id: PartId; rect: PartRect }[] = []
  for (const id of NAVIGABLE_PARTS) {
    const rect = partRect(layout, id)
    if (rect === undefined) continue
    const screen = offsetRectToScreen(rect, win)
    if (screen !== undefined) candidates.push({ id, rect: screen })
  }
  return candidates
}

/**
 * VSCode's `workbench.action.navigate*`: move between editor groups first, then
 * across the side bar / editor / panel / secondary side bar by their on-screen
 * position. The Vim `<leader>w h/j/k/l` chords use these.
 */
abstract class NavigateAction extends Action2 {
  protected constructor(
    id: string,
    title: string,
    private readonly _direction: NavigateDirection,
  ) {
    super({
      id,
      title: localize2(`action.${id}.title`, title),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    // Every service up front: focusing is synchronous here, but keep the rule.
    const layout = accessor.get(ILayoutService)
    const groups = accessor.get(IEditorGroupsService)
    const workbenchWindows = accessor.get(IWorkbenchWindowService)
    const focusContext: ActivateGroupFocusContext = {
      groups,
      contextKeyService: accessor.get(IContextKeyService),
      windowFocus: accessor.get(IWindowFocusService),
      focusStack: accessor.get(IFocusStackService),
    }
    const activeWindow = workbenchWindows.activeWindow
    const direction = this._direction

    // An auxiliary window is all editor area; the main window keeps the
    // focused-part detection.
    const from = activeWindow.isMain
      ? (NAVIGABLE_PARTS.find((id) => isPartFocusedInActiveDocument(layout, id)) ??
        PartId.EditorArea)
      : PartId.EditorArea
    if (from === PartId.EditorArea) {
      // Explicit source: the window is authoritative even while the active part
      // is still catching up with a window switch.
      const group = groups.findGroup(
        { direction: GROUP_DIRECTION[direction] },
        activeWindow.part.activeGroup,
      )
      if (group !== undefined) {
        activateGroupAndFocus(group, focusContext)
        return
      }
    }

    let origin: PartRect | undefined
    if (activeWindow.isMain) {
      const fromRect = partRect(layout, from)
      if (fromRect !== undefined) {
        const candidates = NAVIGABLE_PARTS.filter((id) => id !== from).flatMap((id) => {
          const rect = partRect(layout, id)
          return rect === undefined ? [] : [{ id, rect }]
        })
        const target = findPartInDirection(fromRect, candidates, direction)
        if (target === PartId.EditorArea) {
          focusWindowGroup(activeWindow, focusContext)
          return
        }
        if (target !== undefined) {
          void layout.focusPart(target, { source: 'command' })
          return
        }
      }
      // A collapsed part has no rect; fall back to the whole window so a window
      // in that direction is still reachable.
      origin =
        fromRect !== undefined
          ? offsetRectToScreen(fromRect, activeWindow)
          : windowScreenRect(activeWindow)
    } else {
      origin = windowScreenRect(activeWindow)
    }

    if (origin === undefined) return
    const targetWindow = findWindowInDirection(
      activeWindow.id,
      origin,
      workbenchWindows.windows,
      direction,
    )
    if (targetWindow === undefined) {
      console.debug(`[focus] ${this.desc.id}: no group, part or window ${direction}`)
      return
    }
    if (targetWindow.isMain) {
      // The auxiliary window is whole-editor, but the main window has parts.
      // Pick the nearest part on that side (e.g. the Outline in a right-hand
      // SecondarySideBar) instead of always falling into the editor area.
      const targetPart = findPartInDirection(
        origin,
        screenPartCandidates(layout, targetWindow),
        direction,
      )
      if (targetPart !== undefined && targetPart !== PartId.EditorArea) {
        void layout.focusPart(targetPart, { source: 'command' })
        return
      }
    }
    focusWindowGroup(targetWindow, focusContext)
  }
}

export class NavigateLeftAction extends NavigateAction {
  static readonly ID = 'workbench.action.navigateLeft'
  constructor() {
    super(NavigateLeftAction.ID, 'Navigate to the View on the Left', 'left')
  }
}

export class NavigateRightAction extends NavigateAction {
  static readonly ID = 'workbench.action.navigateRight'
  constructor() {
    super(NavigateRightAction.ID, 'Navigate to the View on the Right', 'right')
  }
}

export class NavigateUpAction extends NavigateAction {
  static readonly ID = 'workbench.action.navigateUp'
  constructor() {
    super(NavigateUpAction.ID, 'Navigate to the View Above', 'up')
  }
}

export class NavigateDownAction extends NavigateAction {
  static readonly ID = 'workbench.action.navigateDown'
  constructor() {
    super(NavigateDownAction.ID, 'Navigate to the View Below', 'down')
  }
}
