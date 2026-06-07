/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Developer diagnostics commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ILayoutService,
  IOutputService,
  IViewsService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IKeyboardDebugService,
  KEYBOARD_DEBUG_CHANNEL,
} from '../services/keybinding/keyboardDebugService.js'
import { formatHeader } from '../services/keybinding/keyboardDebugFormat.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'

export class ToggleKeybindingsTroubleshootingAction extends Action2 {
  static readonly ID = 'workbench.action.toggleKeybindingsLog'

  constructor() {
    super({
      id: ToggleKeybindingsTroubleshootingAction.ID,
      title: localize(
        'action.toggleKeybindingsLog.title',
        'Developer: Toggle Keyboard Shortcuts Troubleshooting',
      ),
      category: localize('command.category.developer', 'Developer'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const keyboardDebugService = accessor.get(IKeyboardDebugService)
    const willEnable = !keyboardDebugService.enabled
    // Write the closing marker while still enabled (append is a no-op once off).
    if (!willEnable) {
      keyboardDebugService.append('Keyboard Shortcuts Troubleshooting — DISABLED')
    }
    keyboardDebugService.toggle()
    if (willEnable) {
      const outputService = accessor.get(IOutputService)
      const layoutService = accessor.get(ILayoutService)
      const viewsService = accessor.get(IViewsService)
      keyboardDebugService.append(formatHeader())
      outputService.setActiveChannel(KEYBOARD_DEBUG_CHANNEL)
      revealOutputPanel(layoutService, viewsService)
    }
  }
}
