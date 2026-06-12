/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the built-in QuickAccess providers (file / file symbols / file
 *  symbols by category / commands / workspace symbols) so the unified quick open
 *  (workbench.action.quickOpen) routes by the input's leading prefix.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  QuickAccessRegistry,
  localize,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { FileQuickAccessProvider } from '../services/quickInput/providers/FileQuickAccessProvider.js'
import {
  FileSymbolByCategoryQuickAccessProvider,
  FileSymbolQuickAccessProvider,
} from '../services/quickInput/providers/FileSymbolQuickAccessProvider.js'
import { CommandsQuickAccessProvider } from '../services/quickInput/providers/CommandsQuickAccessProvider.js'
import { WorkspaceSymbolQuickAccessProvider } from '../services/quickInput/providers/WorkspaceSymbolQuickAccessProvider.js'

export class QuickAccessContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: FileQuickAccessProvider,
        prefix: '',
        placeholder: localize('quickAccess.file.placeholder', 'Go to File…'),
      }),
    )
    this._register(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: FileSymbolByCategoryQuickAccessProvider,
        prefix: '@:',
        placeholder: localize(
          'quickAccess.fileSymbolByCategory.placeholder',
          'Go to Symbol in Editor by Category…',
        ),
      }),
    )
    this._register(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: FileSymbolQuickAccessProvider,
        prefix: '@',
        placeholder: localize('quickAccess.fileSymbol.placeholder', 'Go to Symbol in Editor…'),
      }),
    )
    this._register(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: CommandsQuickAccessProvider,
        prefix: '>',
        placeholder: localize('quickAccess.commands.placeholder', 'Type a command name…'),
      }),
    )
    this._register(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: WorkspaceSymbolQuickAccessProvider,
        prefix: '#',
        placeholder: localize(
          'quickAccess.workspaceSymbol.placeholder',
          'Go to Symbol in Workspace…',
        ),
      }),
    )
  }
}
