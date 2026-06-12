/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Command palette quick access ('>'): project commands (CommandsRegistry) plus
 *  the active Monaco editor's actions, de-duped, word-matched. Mirrors VSCode's
 *  commands quick access (workbench.action.showCommands).
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  ICommandService,
  IEditorGroupsService,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
} from '@universe-editor/platform'
import {
  collectMonacoCommands,
  isMonacoCommandItem,
  type MonacoCommandItem,
} from '../monacoCommandSource.js'
import { resolveShortcut } from '../../../workbench/titlebar/keybindingFormat.js'

export class CommandsQuickAccessProvider implements IQuickAccessProvider {
  constructor(
    @ICommandService private readonly _commands: ICommandService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
  ) {}

  provide(picker: IQuickPick<IQuickPickItem>, _options: IQuickAccessProviderRunOptions): void {
    picker.filterMode = 'word'

    const registryItems: IQuickPickItem[] = [...CommandsRegistry.getCommands().values()].map(
      (cmd) => {
        const keybinding = resolveShortcut(cmd.id)
        const title = cmd.metadata?.description ?? cmd.id
        const category = cmd.metadata?.category
        return {
          id: cmd.id,
          label: category !== undefined ? `${category}: ${title}` : title,
          ...(keybinding !== undefined ? { keybinding } : {}),
        }
      },
    )
    const monacoItems: MonacoCommandItem[] = collectMonacoCommands(this._groups)
    // De-dupe: a Monaco action id can collide with a project command id; prefer
    // the project command (project intent wins, Monaco is a fallback source).
    const projectIds = new Set(registryItems.map((i) => i.id))
    picker.items = [...registryItems, ...monacoItems.filter((m) => !projectIds.has(m.id))]

    _options.disposables.add(
      picker.onDidAccept((items) => {
        const selected = items[0]
        picker.hide()
        if (!selected) return
        if (isMonacoCommandItem(selected)) {
          void selected._editor.getAction(selected._actionId)?.run()
        } else {
          void this._commands.executeCommand(selected.id)
        }
      }),
    )
  }
}
