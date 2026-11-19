/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Terminal Normal Mode commands. The dispatcher's default Vim keymap names
 *  these ids; handlers forward to the live TerminalNormalModeController of the
 *  terminal that owns DOM focus. Registered in Wave 0's action loop, so adding
 *  a class to TERMINAL_NORMAL_ACTIONS is enough.
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

export class TerminalNormalScrollLineUpAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollLineUp'
  constructor() {
    super(options(TerminalNormalScrollLineUpAction.ID, 'Terminal Normal: Scroll Line Up'))
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollLines(-1, readCount(arg))
  }
}

export class TerminalNormalScrollLineDownAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollLineDown'
  constructor() {
    super(options(TerminalNormalScrollLineDownAction.ID, 'Terminal Normal: Scroll Line Down'))
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollLines(1, readCount(arg))
  }
}

export class TerminalNormalScrollHalfPageUpAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollHalfPageUp'
  constructor() {
    super(options(TerminalNormalScrollHalfPageUpAction.ID, 'Terminal Normal: Scroll Half Page Up'))
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollHalfPage('up', readCount(arg))
  }
}

export class TerminalNormalScrollHalfPageDownAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollHalfPageDown'
  constructor() {
    super(
      options(TerminalNormalScrollHalfPageDownAction.ID, 'Terminal Normal: Scroll Half Page Down'),
    )
  }

  override run(_accessor: ServicesAccessor, arg?: unknown): void {
    focused()?.scrollHalfPage('down', readCount(arg))
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

export class TerminalNormalScrollToTopAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollToTop'
  constructor() {
    super(options(TerminalNormalScrollToTopAction.ID, 'Terminal Normal: Scroll to Top'))
  }

  override run(_accessor: ServicesAccessor): void {
    focused()?.scrollToTop()
  }
}

export class TerminalNormalScrollToBottomAction extends Action2 {
  static readonly ID = 'workbench.action.terminal.normalScrollToBottom'
  constructor() {
    super(options(TerminalNormalScrollToBottomAction.ID, 'Terminal Normal: Scroll to Bottom'))
  }

  override run(_accessor: ServicesAccessor): void {
    focused()?.scrollToBottom()
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
  TerminalNormalScrollLineUpAction,
  TerminalNormalScrollLineDownAction,
  TerminalNormalScrollHalfPageUpAction,
  TerminalNormalScrollHalfPageDownAction,
  TerminalNormalScrollPageUpAction,
  TerminalNormalScrollPageDownAction,
  TerminalNormalScrollToTopAction,
  TerminalNormalScrollToBottomAction,
  TerminalNormalStartSelectionAction,
  TerminalNormalCopySelectionAction,
] as const
