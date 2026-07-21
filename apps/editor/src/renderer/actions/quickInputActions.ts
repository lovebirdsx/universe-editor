/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action that closes the currently visible Quick Input panel. Bound to Escape
 *  but gated on the `quickInputVisible` ContextKey so it only competes for the
 *  key while a panel is showing.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

// Above the default WorkbenchContrib so the scoped Escape wins over any lower-weight
// Escape binding whenever a Quick Input panel is visible, regardless of registration order.
const QUICK_INPUT_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

export class CloseQuickInputAction extends Action2 {
  static readonly ID = 'workbench.action.closeQuickInput'
  constructor() {
    super({
      id: CloseQuickInputAction.ID,
      title: localize2('action.closeQuickInput.title', 'Close Quick Input'),
      keybinding: { primary: 'escape', when: 'quickInputVisible', weight: QUICK_INPUT_KEY_WEIGHT },
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IQuickInputService).hide()
  }
}
