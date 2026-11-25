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
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IFocusStackService,
  ILayoutService,
  PartId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { activateGroupAndFocus } from '../services/editor/activateGroupAndFocus.js'
import { isPartFocusedInActiveDocument } from '../services/focus/partFocus.js'
import {
  findPartInDirection,
  type NavigateDirection,
  type PartRect,
} from '../services/focus/partDirection.js'
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
    const commands = accessor.get(ICommandService)
    const focusContext = {
      groups,
      contextKeyService: accessor.get(IContextKeyService),
      windowFocus: accessor.get(IWindowFocusService),
      focusStack: accessor.get(IFocusStackService),
    }
    const from =
      NAVIGABLE_PARTS.find((id) => isPartFocusedInActiveDocument(layout, id)) ?? PartId.EditorArea
    if (from === PartId.EditorArea) {
      const group = groups.findGroup({ direction: GROUP_DIRECTION[this._direction] })
      if (group !== undefined) {
        activateGroupAndFocus(group, focusContext)
        return
      }
    }
    const fromRect = partRect(layout, from)
    if (fromRect === undefined) return
    const candidates = NAVIGABLE_PARTS.filter((id) => id !== from).flatMap((id) => {
      const rect = partRect(layout, id)
      return rect === undefined ? [] : [{ id, rect }]
    })
    const target = findPartInDirection(fromRect, candidates, this._direction)
    if (target === undefined) {
      console.debug(`[focus] ${this.desc.id}: no part ${this._direction} of ${from}`)
      return
    }
    if (target === PartId.EditorArea) {
      void commands.executeCommand('workbench.action.focusActiveEditorGroup')
      return
    }
    void layout.focusPart(target, { source: 'command' })
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
