/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action that closes the currently visible Quick Input panel. Bound to Escape
 *  but gated on the `quickInputVisible` ContextKey so it only competes for the
 *  key while a panel is showing.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class CloseQuickInputAction extends Action2 {
  static readonly ID = 'workbench.action.closeQuickInput'
  constructor() {
    super({
      id: CloseQuickInputAction.ID,
      title: localize('action.closeQuickInput.title', 'Close Quick Input'),
      keybinding: { primary: 'escape', when: 'quickInputVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IQuickInputService).hide()
  }
}
