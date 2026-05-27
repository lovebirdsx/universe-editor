/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Focus navigation Action2 definitions: F6 / Shift+F6 / dump focus state.
 *
 *  Group-level focus (alt+0/9, ctrl+k arrows) and Escape-to-editor live in
 *  editorActions.ts. This file is for cross-Part navigation, driven by
 *  IFocusStackService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IFocusStackService,
  ILayoutService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class FocusNextPartAction extends Action2 {
  static readonly ID = 'workbench.action.focusNextPart'
  constructor() {
    super({
      id: FocusNextPartAction.ID,
      title: localize('action.focusNextPart.title', 'Focus Next Part'),
      category: localize('command.category.view', 'View'),
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
      title: localize('action.focusPreviousPart.title', 'Focus Previous Part'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'shift+f6', when: '!quickInputVisible' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const prev = accessor.get(IFocusStackService).previousPart()
    if (prev) await accessor.get(ILayoutService).focusPart(prev, { source: 'command' })
  }
}
