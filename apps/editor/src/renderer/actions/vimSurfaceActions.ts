/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic Vim surface commands (`list.*` / `surface.*`). Each forwards to the
 *  `actions` of the surface that owns the keyboard; a surface that does not
 *  implement an action ignores it. Lists, trees, menus, the terminal and the
 *  Markdown preview all share these ids.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IContextKeyService,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { getActiveVimSurface, type IVimSurfaceActions } from '@universe-editor/workbench-ui'
import { getActiveWorkbenchDocument } from '../services/windows/workbenchDocuments.js'

const FOCUS_ACTIVE_EDITOR_GROUP = 'workbench.action.focusActiveEditorGroup'
const FOCUS_EDITOR_TABS = 'workbench.action.focusEditorTabs'

type Invoke = (actions: IVimSurfaceActions, count: number, hasCount: boolean) => void

function readCount(arg: unknown): number {
  if (typeof arg === 'object' && arg !== null) {
    const count = (arg as { count?: unknown }).count
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) return Math.floor(count)
  }
  return 1
}

// The dispatcher sends `hasCount`; a direct command call without it counts as typed only above 1.
function readHasCount(arg: unknown): boolean {
  if (typeof arg === 'object' && arg !== null) {
    const hasCount = (arg as { hasCount?: unknown }).hasCount
    if (typeof hasCount === 'boolean') return hasCount
  }
  return readCount(arg) > 1
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
    this._invoke(active.surface.actions, readCount(args[0]), readHasCount(args[0]))
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
    super(options(ListFocusFirstAction.ID, 'Focus First Item'), (actions, count, hasCount) =>
      actions.first?.(hasCount ? count : 0),
    )
  }
}

export class ListFocusLastAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.focusLast'
  constructor() {
    super(options(ListFocusLastAction.ID, 'Focus Last Item'), (actions, count, hasCount) =>
      actions.last?.(hasCount ? count : 0),
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

export class ListScrollViewportUpAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.scrollViewportUp'
  constructor() {
    super(options(ListScrollViewportUpAction.ID, 'Scroll View Up in List'), (actions, count) =>
      actions.scrollViewport?.('up', count),
    )
  }
}

export class ListScrollViewportDownAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.scrollViewportDown'
  constructor() {
    super(options(ListScrollViewportDownAction.ID, 'Scroll View Down in List'), (actions, count) =>
      actions.scrollViewport?.('down', count),
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

export class ListFindAction extends VimSurfaceCommandAction {
  static readonly ID = 'list.find'
  constructor() {
    super(options(ListFindAction.ID, 'Find in List'), (actions) => actions.find?.())
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

export class SurfaceEscapeAction extends Action2 {
  static readonly ID = 'surface.escape'
  constructor() {
    super(options(SurfaceEscapeAction.ID, 'Escape Surface'))
  }

  override run(accessor: ServicesAccessor, ...args: unknown[]): void {
    const active = getActiveVimSurface(getActiveWorkbenchDocument())
    if (active === undefined) {
      console.debug(`[vim] ${SurfaceEscapeAction.ID}: no active surface`)
      return
    }
    const { kind, actions } = active.surface
    const escaped = actions.escape?.(readCount(args[0]))
    // Vim's list Esc used to swallow the workbench's own "Esc leaves the view":
    // once there is nothing left to escape, the focus has to go somewhere.
    if (kind !== 'list' || (actions.escape !== undefined && escaped !== false)) return
    const contextKeys = accessor.get(IContextKeyService)
    const commands = accessor.get(ICommandService)
    // A list inside the editor area (graph, session timeline, settings) is not a
    // view: idle Esc hands focus to the tab strip, matching a text editor's idle
    // Esc. `editorAreaFocus` keeps portalled lists (breadcrumb pickers) out, which
    // have no `focusedView` either but are not in the editor area.
    if (contextKeys.get('editorAreaFocus') === true) {
      void commands.executeCommand(FOCUS_EDITOR_TABS)
      return
    }
    // Side bar / panel view lists return to the editor.
    if (contextKeys.get('focusedView')) {
      void commands.executeCommand(FOCUS_ACTIVE_EDITOR_GROUP)
    }
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
  ListScrollViewportUpAction,
  ListScrollViewportDownAction,
  ListExpandAction,
  ListCollapseAction,
  ListToggleAction,
  ListActivateAction,
  ListActivatePreviewAction,
  ListContextMenuAction,
  ListFindAction,
  ListCopyAction,
  ListDeleteAction,
  SurfaceNextAction,
  SurfacePreviousAction,
  SurfaceEscapeAction,
] as const
