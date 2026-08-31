/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol navigation commands. Both route into the unified QuickAccess picker
 *  (workbench.action.quickOpen) by prefilling its prefix — the actual pickers
 *  live in services/quickInput/providers/. Command ids mirror VSCode:
 *    - workbench.action.showAllSymbols (Ctrl+T) → '#' workspace symbols
 *    - workbench.action.gotoSymbol (Ctrl+R) → '@' editor symbols
 *  Note: ctrl+r is also Open Recent's key and, at equal weight, the later
 *  registration (Open Recent) wins it everywhere EXCEPT the graph editors,
 *  where gotoSymbol's scoped twin below takes precedence.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IQuickAccessController } from '../services/quickInput/QuickAccessController.js'

export class GoToWorkspaceSymbolAction extends Action2 {
  static readonly ID = 'workbench.action.showAllSymbols'
  constructor() {
    super({
      id: GoToWorkspaceSymbolAction.ID,
      title: localize2('action.showAllSymbols.title', 'Go to Symbol in Workspace…'),
      category: localize2('command.category.go', 'Go'),
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
      title: localize2('action.gotoSymbol.title', 'Go to Symbol in Editor…'),
      category: localize2('command.category.go', 'Go'),
      keybinding: [
        // Plain ctrl+r: Open Recent shares the key and wins it (registered
        // later, same default weight). In the graph editors the commits are
        // listed as symbols, so there gotoSymbol must win instead — hence the
        // extra scoped, weighted twin.
        { primary: 'ctrl+r', when: '!terminalFocus' },
        {
          primary: 'ctrl+r',
          when: "activeEditorId == 'universe:/gitGraph' || activeEditorType == 'perforceGraph'",
          weight: KeybindingWeight.WorkbenchContrib + 50,
        },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IQuickAccessController).show('@')
  }
}
