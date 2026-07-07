/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Explorer / files settings that drive delete-to-trash, delete
 *  confirmation, and file-operation undo, and keeps the `explorerEnableUndo`
 *  context key (gating the Ctrl+Z / Ctrl+Y keybindings) in sync with config.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IContextKeyService,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class ExplorerFileConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IConfigurationService config: IConfigurationService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'explorer',
        title: localize('settings.explorer', 'Explorer'),
        properties: {
          'files.enableTrash': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.files.enableTrash',
              'Move files/folders to the OS trash (recycle bin) when deleting. When off, deletions are permanent.',
            ),
          },
          'explorer.confirmDelete': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.explorer.confirmDelete',
              'Ask for confirmation before deleting a file or folder from the Explorer.',
            ),
          },
          'explorer.enableUndo': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.explorer.enableUndo',
              'Enable undo/redo (Ctrl+Z / Ctrl+Y) for Explorer file operations such as create, rename, move, copy, and delete.',
            ),
          },
        },
      }),
    )

    const enableUndo = contextKeyService.createKey<boolean>(
      'explorerEnableUndo',
      config.get<boolean>('explorer.enableUndo') !== false,
    )
    this._register(
      config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('explorer.enableUndo')) {
          enableUndo.set(config.get<boolean>('explorer.enableUndo') !== false)
        }
      }),
    )
  }
}
