/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Terminal Normal Mode commands that have no generic counterpart: the mode
 *  switches, full-page scroll, and the linewise selection. Plain motion (j/k,
 *  Ctrl+D/U/E/Y, gg/G) goes through the `list.*` commands and the terminal
 *  surface's `actions` (see `createTerminalSurfaceActions`). Handlers forward to
 *  the controller of the terminal that owns DOM focus; adding a class to
 *  TERMINAL_NORMAL_ACTIONS is enough to register it.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  getFocusedTerminalNormalModeController,
  type ITerminalNormalModeController,
} from '../services/terminal/terminalNormalModeRegistry.js'

const CATEGORY = localize2('command.category.terminal', 'Terminal')

function options(id: string, title: string): IAction2Options {
  return { id, title: localize2(`action.${id}.title`, title), category: CATEGORY, f1: true }
}

function focused(): ITerminalNormalModeController | undefined {
  return getFocusedTerminalNormalModeController()
}

/** The dispatcher passes `{ count }`; Vim's implicit count is 1. */
function readCount(arg: unknown): number {
  if (typeof arg === 'object' && arg !== null) {
    const count = (arg as { count?: unknown }).count
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      return Math.max(1, Math.floor(count))
    }
  }
  return 1
}

/** `ctrl+shift+\` has no platform-registry rival; the scoped `when` is enough. */
export class TerminalEnterNormalModeAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.enterNormalMode'
  constructor() {
    super({
      ...options(TerminalEnterNormalModeAction.ID, 'Enter Terminal Normal Mode'),
      keybinding: { primary: 'ctrl+shift+\\', when: 'terminalFocus' },
    })
  }

  override run(_accessor: ServicesAccessor): void {
    focused()?.enterNormalMode()
  }
}

export class TerminalExitNormalModeAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.exitNormalMode'
  constructor() {
    super(options(TerminalExitNormalModeAction.ID, 'Exit Terminal Normal Mode'))
  }

  override run(_accessor: ServicesAccessor): void {
    focused()?.exitNormalMode()
  }
}

export class TerminalNormalScrollPageUpAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollPageUp'
  constructor() {
    super(options(TerminalNormalScrollPageUpAction.ID, 'Terminal Normal: Scroll Page Up'))
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollPage('up', readCount(arg))
  }
}

export class TerminalNormalScrollPageDownAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollPageDown'
  constructor() {
    super(options(TerminalNormalScrollPageDownAction.ID, 'Terminal Normal: Scroll Page Down'))
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollPage('down', readCount(arg))
  }
}

export class TerminalNormalStartSelectionAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalStartSelection'
  constructor() {
    super(options(TerminalNormalStartSelectionAction.ID, 'Terminal Normal: Start Selection'))
  }

  override run(_accessor: ServicesAccessor): void {
    focused()?.startSelection()
  }
}

export class TerminalNormalCopySelectionAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalCopySelection'
  constructor() {
    super(options(TerminalNormalCopySelectionAction.ID, 'Terminal Normal: Copy Selection'))
  }

  override run(_accessor: ServicesAccessor): void {
    // Snapshot before the await: the focus registry is only read here.
    const controller = focused()
    if (controller === undefined) return
    void controller.copySelection().then((copied) => {
      if (copied) controller.exitNormalMode()
    })
  }
}

export const TERMINAL_NORMAL_ACTIONS = [
  TerminalEnterNormalModeAction,
  TerminalExitNormalModeAction,
  TerminalNormalScrollPageUpAction,
  TerminalNormalScrollPageDownAction,
  TerminalNormalStartSelectionAction,
  TerminalNormalCopySelectionAction,
] as const
