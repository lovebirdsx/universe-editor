/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Command palette quick access ('>'): commands surfaced in MenuId.CommandPalette
 *  (filtered by their when-clause against the live context) plus the active Monaco
 *  editor's actions, de-duped, word-matched. Mirrors VSCode's commands quick access
 *  (workbench.action.showCommands), which lists MenuRegistry's CommandPalette menu —
 *  not the raw CommandsRegistry — so context-irrelevant commands stay hidden.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  IContextKeyService,
  ICommandService,
  IEditorGroupsService,
  IStorageService,
  isSubmenuEntry,
  MenuId,
  MenuRegistry,
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

// Shared with the pre-QuickAccess-refactor command palette so existing recently-used
// history carries over. Most-recent-first, capped to keep the ranking meaningful.
const MRU_STORAGE_KEY = 'quickinput.mru.workbench.commandPalette'
const MRU_LIMIT = 20

export class CommandsQuickAccessProvider implements IQuickAccessProvider {
  constructor(
    @ICommandService private readonly _commands: ICommandService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IContextKeyService private readonly _contextKeyService: IContextKeyService,
    @IStorageService private readonly _storage: IStorageService,
  ) {}

  provide(picker: IQuickPick<IQuickPickItem>, _options: IQuickAccessProviderRunOptions): void {
    picker.filterMode = 'word'

    let mruIds: string[] = []
    // Seed the recently-used ranking asynchronously; bail if the picker was torn
    // down (prefix switch / hide) before storage resolved.
    void this._storage.get<string[]>(MRU_STORAGE_KEY).then((stored) => {
      if (_options.token.isCancellationRequested) return
      mruIds = stored ?? []
      picker.mruIds = mruIds
    })

    const seenRegistryIds = new Set<string>()
    const registryItems: IQuickPickItem[] = []
    for (const entry of MenuRegistry.getMenuItems(MenuId.CommandPalette, this._contextKeyService)) {
      if (isSubmenuEntry(entry)) continue
      if (seenRegistryIds.has(entry.command)) continue
      seenRegistryIds.add(entry.command)
      const command = CommandsRegistry.getCommand(entry.command)
      const keybinding = resolveShortcut(entry.command)
      const title = entry.title ?? command?.metadata?.description ?? entry.command
      const category = command?.metadata?.category
      const originalTitle = command?.metadata?.originalDescription
      const originalCategory = command?.metadata?.originalCategory
      const englishLabel =
        originalTitle !== undefined
          ? originalCategory !== undefined
            ? `${originalCategory}: ${originalTitle}`
            : originalTitle
          : undefined
      const keywords = [englishLabel, entry.command].filter(
        (k): k is string => k !== undefined && k.length > 0,
      )
      registryItems.push({
        id: entry.command,
        label: category !== undefined ? `${category}: ${title}` : title,
        keywords,
        ...(keybinding !== undefined ? { keybinding } : {}),
      })
    }
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
        mruIds = [selected.id, ...mruIds.filter((x) => x !== selected.id)].slice(0, MRU_LIMIT)
        void this._storage.set(MRU_STORAGE_KEY, mruIds)
        // Defer the command run past the accept handler's synchronous tail: the
        // panel's accept also calls the service's hide() after this callback, so a
        // command that synchronously opens its own quick input (e.g. an API-key
        // prompt) would otherwise be torn down the instant it appears.
        queueMicrotask(() => {
          if (isMonacoCommandItem(selected)) {
            void selected._editor.getAction(selected._actionId)?.run()
          } else {
            void this._commands.executeCommand(selected.id)
          }
        })
      }),
    )
  }
}
