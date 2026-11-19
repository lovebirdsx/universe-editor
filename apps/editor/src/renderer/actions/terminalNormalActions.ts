/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Terminal Normal Mode command ids. Registered in Wave 0 so the dispatcher's
 *  default keymap can name them; handlers are implemented by WP5 together with
 *  the terminal surface and `terminalNormalMode.ts`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize2('command.category.terminal', 'Terminal')

function options(id: string, title: string): IAction2Options {
  return { id, title: localize2(`action.${id}.title`, title), category: CATEGORY }
}

/** Placeholder until WP5 wires the active terminal's normal-mode controller. */
abstract class TerminalNormalAction extends Action2 {
  protected constructor(optionsValue: IAction2Options) {
    super(optionsValue)
  }

  override run(_accessor: ServicesAccessor): void {
    // WP5: forward to the focused terminal's normal-mode controller.
  }
}

export class TerminalEnterNormalModeAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.enterNormalMode'
  constructor() {
    super(options(TerminalEnterNormalModeAction.ID, 'Enter Terminal Normal Mode'))
  }
}

export class TerminalExitNormalModeAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.exitNormalMode'
  constructor() {
    super(options(TerminalExitNormalModeAction.ID, 'Exit Terminal Normal Mode'))
  }
}

export class TerminalNormalScrollLineUpAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollLineUp'
  constructor() {
    super(options(TerminalNormalScrollLineUpAction.ID, 'Terminal Normal: Scroll Line Up'))
  }
}

export class TerminalNormalScrollLineDownAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollLineDown'
  constructor() {
    super(options(TerminalNormalScrollLineDownAction.ID, 'Terminal Normal: Scroll Line Down'))
  }
}

export class TerminalNormalScrollHalfPageUpAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollHalfPageUp'
  constructor() {
    super(options(TerminalNormalScrollHalfPageUpAction.ID, 'Terminal Normal: Scroll Half Page Up'))
  }
}

export class TerminalNormalScrollHalfPageDownAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollHalfPageDown'
  constructor() {
    super(
      options(TerminalNormalScrollHalfPageDownAction.ID, 'Terminal Normal: Scroll Half Page Down'),
    )
  }
}

export class TerminalNormalScrollToTopAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollToTop'
  constructor() {
    super(options(TerminalNormalScrollToTopAction.ID, 'Terminal Normal: Scroll to Top'))
  }
}

export class TerminalNormalScrollToBottomAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalScrollToBottom'
  constructor() {
    super(options(TerminalNormalScrollToBottomAction.ID, 'Terminal Normal: Scroll to Bottom'))
  }
}

export class TerminalNormalStartSelectionAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalStartSelection'
  constructor() {
    super(options(TerminalNormalStartSelectionAction.ID, 'Terminal Normal: Start Selection'))
  }
}

export class TerminalNormalCopySelectionAction extends TerminalNormalAction {
  static readonly ID = 'workbench.action.terminal.normalCopySelection'
  constructor() {
    super(options(TerminalNormalCopySelectionAction.ID, 'Terminal Normal: Copy Selection'))
  }
}

export const TERMINAL_NORMAL_ACTIONS = [
  TerminalEnterNormalModeAction,
  TerminalExitNormalModeAction,
  TerminalNormalScrollLineUpAction,
  TerminalNormalScrollLineDownAction,
  TerminalNormalScrollHalfPageUpAction,
  TerminalNormalScrollHalfPageDownAction,
  TerminalNormalScrollToTopAction,
  TerminalNormalScrollToBottomAction,
  TerminalNormalStartSelectionAction,
  TerminalNormalCopySelectionAction,
] as const
