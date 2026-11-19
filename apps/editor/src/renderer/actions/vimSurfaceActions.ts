/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic Vim surface commands. Wave 0 registers every id up front so later
 *  work packages only add adapter actions; the commands themselves already
 *  forward to the active surface (throwing away nothing for adapters that exist).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { getActiveVimSurface, type IVimSurfaceActions } from '@universe-editor/workbench-ui'
import { getActiveWorkbenchDocument } from '../services/windows/workbenchDocuments.js'

type Invoke = (actions: IVimSurfaceActions, count: number) => void

function readCount(arg: unknown): number {
  if (typeof arg === 'object' && arg !== null) {
    const count = (arg as { count?: unknown }).count
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) return Math.floor(count)
  }
  return 1
}

abstract class VimSurfaceCommandAction extends Action2 {
  protected constructor(
    options: IAction2Options,
    private readonly _invoke: Invoke,
  ) {
    super(options)
  }

  override run(_accessor: ServicesAccessor, ...args: unknown[]): void {
    // No service is needed: the active surface is resolved from DOM focus, and
    // the accessor would die at the first await anyway.
    const active = getActiveVimSurface(getActiveWorkbenchDocument())
    if (active === undefined) {
      console.debug(`[vim] ${this.desc.id}: no active surface`)
      return
    }
    this._invoke(active.surface.actions, readCount(args[0]))
  }
}

const VIM_CATEGORY = localize2('command.category.vim', 'Vim')

function options(id: string, title: string) {
  return { id, title: localize2(`action.vim.${id}.title`, title), category: VIM_CATEGORY }
}

export class ListFocusUpAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusUp'
  constructor() {
    super(options(ListFocusUpAction.ID, 'Move Up in List'), (actions, count) =>
      actions.move?.('up', count),
    )
  }
}

export class ListFocusDownAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusDown'
  constructor() {
    super(options(ListFocusDownAction.ID, 'Move Down in List'), (actions, count) =>
      actions.move?.('down', count),
    )
  }
}

export class ListFocusLeftAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusLeft'
  constructor() {
    super(options(ListFocusLeftAction.ID, 'Move Left in List'), (actions, count) =>
      actions.move?.('left', count),
    )
  }
}

export class ListFocusRightAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusRight'
  constructor() {
    super(options(ListFocusRightAction.ID, 'Move Right in List'), (actions, count) =>
      actions.move?.('right', count),
    )
  }
}

export class ListFocusFirstAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusFirst'
  constructor() {
    super(options(ListFocusFirstAction.ID, 'Focus First Item'), (actions, count) =>
      actions.first?.(count),
    )
  }
}

export class ListFocusLastAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusLast'
  constructor() {
    super(options(ListFocusLastAction.ID, 'Focus Last Item'), (actions, count) =>
      actions.last?.(count),
    )
  }
}

export class ListPageUpAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.pageUp'
  constructor() {
    super(options(ListPageUpAction.ID, 'Page Up in List'), (actions, count) =>
      actions.page?.('up', count),
    )
  }
}

export class ListPageDownAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.pageDown'
  constructor() {
    super(options(ListPageDownAction.ID, 'Page Down in List'), (actions, count) =>
      actions.page?.('down', count),
    )
  }
}

export class ListExpandAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.expand'
  constructor() {
    super(options(ListExpandAction.ID, 'Expand Item'), (actions, count) => actions.expand?.(count))
  }
}

export class ListCollapseAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.collapse'
  constructor() {
    super(options(ListCollapseAction.ID, 'Collapse Item'), (actions, count) =>
      actions.collapse?.(count),
    )
  }
}

export class ListToggleAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.toggle'
  constructor() {
    super(options(ListToggleAction.ID, 'Toggle Item'), (actions, count) => actions.toggle?.(count))
  }
}

export class ListActivateAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.activate'
  constructor() {
    super(options(ListActivateAction.ID, 'Activate Item'), (actions, count) =>
      actions.activate?.(count, false),
    )
  }
}

export class ListActivatePreviewAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.activatePreview'
  constructor() {
    super(options(ListActivatePreviewAction.ID, 'Preview Item'), (actions, count) =>
      actions.activate?.(count, true),
    )
  }
}

export class ListContextMenuAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.contextMenu'
  constructor() {
    super(options(ListContextMenuAction.ID, 'Open Item Context Menu'), (actions, count) =>
      actions.contextMenu?.(count),
    )
  }
}

export class ListCopyAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.copy'
  constructor() {
    super(options(ListCopyAction.ID, 'Copy Item'), (actions, count) => actions.copy?.(count))
  }
}

export class ListDeleteAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.delete'
  constructor() {
    super(options(ListDeleteAction.ID, 'Delete Item'), (actions, count) => actions.remove?.(count))
  }
}

export class SurfaceNextAction extends VimSurfaceCommandAction {
  static readonly ID = 'surface.next'
  constructor() {
    super(options(SurfaceNextAction.ID, 'Focus Next Surface Item'), (actions, count) =>
      actions.next?.(count),
    )
  }
}

export class SurfacePreviousAction extends VimSurfaceCommandAction {
  static readonly ID = 'surface.previous'
  constructor() {
    super(options(SurfacePreviousAction.ID, 'Focus Previous Surface Item'), (actions, count) =>
      actions.previous?.(count),
    )
  }
}

export class SurfaceEscapeAction extends VimSurfaceCommandAction {
  static readonly ID = 'surface.escape'
  constructor() {
    super(options(SurfaceEscapeAction.ID, 'Escape Surface'), (actions, count) =>
      actions.escape?.(count),
    )
  }
}

export const VIM_SURFACE_ACTIONS = [
  ListFocusUpAction,
  ListFocusDownAction,
  ListFocusLeftAction,
  ListFocusRightAction,
  ListFocusFirstAction,
  ListFocusLastAction,
  ListPageUpAction,
  ListPageDownAction,
  ListExpandAction,
  ListCollapseAction,
  ListToggleAction,
  ListActivateAction,
  ListActivatePreviewAction,
  ListContextMenuAction,
  ListCopyAction,
  ListDeleteAction,
  SurfaceNextAction,
  SurfacePreviousAction,
  SurfaceEscapeAction,
] as const
