/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol navigation commands. Both route into the unified QuickAccess picker
 *  (workbench.action.quickOpen) by prefilling its prefix — the actual pickers
 *  live in services/quickInput/providers/. Command ids mirror VSCode:
 *    - workbench.action.showAllSymbols (Ctrl+T) → '#' workspace symbols
 *    - workbench.action.gotoSymbol (Ctrl+Shift+O) → '@' editor symbols
 *--------------------------------------------------------------------------------------------*/

import { Action2, localize, type ServicesAccessor } from '@universe-editor/platform'
import { IQuickAccessController } from '../services/quickInput/QuickAccessController.js'

export class GoToWorkspaceSymbolAction extends Action2 {
  static readonly ID = 'workbench.action.showAllSymbols'
  constructor() {
    super({
      id: GoToWorkspaceSymbolAction.ID,
      title: localize('action.showAllSymbols.title', 'Go to Symbol in Workspace…'),
      category: localize('command.category.go', 'Go'),
      keybinding: { primary: 'ctrl+t' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IQuickAccessController).show('#')
  }
}

export class GoToFileSymbolAction extends Action2 {
  static readonly ID = 'workbench.action.gotoSymbol'
  constructor() {
    super({
      id: GoToFileSymbolAction.ID,
      title: localize('action.gotoSymbol.title', 'Go to Symbol in Editor…'),
      category: localize('command.category.go', 'Go'),
      keybinding: { primary: 'ctrl+shift+o' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IQuickAccessController).show('@')
  }
}
