/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers the `workbench.action.showCommands` command + Ctrl+Shift+P keybinding
 *  that opens the command palette.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  ICommandService,
  IQuickInputService,
  IWorkbenchContribution,
  KeybindingsRegistry,
} from '@universe-editor/platform'

export class CommandPaletteContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      CommandsRegistry.registerCommand(
        'workbench.action.showCommands',
        async (accessor) => {
          const quickInputService = accessor.get(IQuickInputService)
          const commandService = accessor.get(ICommandService)
          const commands = [...CommandsRegistry.getCommands().values()].map((cmd) => ({
            id: cmd.id,
            label: cmd.metadata?.description ?? cmd.id,
            ...(cmd.metadata?.category !== undefined ? { description: cmd.metadata.category } : {}),
          }))
          const selected = await quickInputService.pick(commands, {
            id: 'workbench.commandPalette',
            placeholder: 'Type a command name…',
          })
          if (selected) {
            void commandService.executeCommand(selected.id)
          }
        },
        { description: 'Show All Commands', category: 'View' },
      ),
    )
    this._register(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+shift+p',
        command: 'workbench.action.showCommands',
      }),
    )
  }
}
