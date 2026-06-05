/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Translates an extension's STATIC contributions (declared in its manifest)
 *  into the core registries BEFORE activation, so contributed commands are
 *  visible in the command palette and can trigger lazy activation on first use.
 *
 *  Each contributed command becomes a CommandsRegistry "bootstrap proxy": the
 *  first invocation fires the `onCommand:<id>` activation event, waits for the
 *  extension to activate (which registers its real handler in the host), then
 *  executes the command in the host. No re-dispatch through ICommandService, so
 *  there is no risk of looping if activation fails to register the handler.
 *
 *  Menus / keybindings / configuration are likewise translated into MenuRegistry
 *  / KeybindingsRegistry / ConfigurationRegistry. Unknown menu locations are
 *  ignored (with a warning) for forward-compatibility.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  ConfigurationRegistry,
  Disposable,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  type ICommandMetadata,
  type IKeybindingItem,
} from '@universe-editor/platform'
import {
  commandActivationEvent,
  type ICommandContribution,
  type IConfigurationContribution,
  type IExtensionDescriptionDto,
  type IKeybindingContribution,
  type IMenuContribution,
} from '@universe-editor/extensions-common'

/** Maps VSCode-style manifest menu keys to our internal MenuId. */
const MENU_ID_BY_KEY: Readonly<Record<string, MenuId>> = {
  commandPalette: MenuId.CommandPalette,
  'editor/title': MenuId.EditorTitle,
  'editor/context': MenuId.EditorContext,
  'explorer/context': MenuId.ExplorerContext,
  'scm/title': MenuId.ScmTitle,
  'scm/resourceState/context': MenuId.ScmResourceStateContext,
  'scm/resourceGroup/context': MenuId.ScmResourceGroupContext,
}

/** Splits a `group@order` string (VSCode convention) into its parts. */
function parseGroup(group: string | undefined): { group?: string; order?: number } {
  if (group === undefined) return {}
  const at = group.lastIndexOf('@')
  if (at === -1) return { group }
  const order = Number(group.slice(at + 1))
  const name = group.slice(0, at)
  return { group: name, ...(Number.isFinite(order) ? { order } : {}) }
}

export class ExtensionPointTranslator extends Disposable {
  constructor(
    private readonly _activateByEvent: (event: string) => Promise<void>,
    private readonly _executeContributedCommand: (id: string, args: unknown[]) => Promise<unknown>,
  ) {
    super()
  }

  translate(extensions: readonly IExtensionDescriptionDto[]): void {
    for (const ext of extensions) {
      const contributes = ext.contributes
      for (const command of contributes.commands ?? []) {
        this._registerCommand(command)
      }
      if (contributes.menus) {
        this._registerMenus(contributes.menus)
      }
      for (const keybinding of contributes.keybindings ?? []) {
        this._registerKeybinding(keybinding)
      }
      this._registerConfiguration(ext.id, contributes.configuration)
    }
  }

  private _registerCommand(command: ICommandContribution): void {
    const metadata: ICommandMetadata = {
      description: command.title,
      ...(command.category !== undefined ? { category: command.category } : {}),
    }
    this._register(
      CommandsRegistry.registerCommand({
        id: command.command,
        handler: async (_accessor, ...args) => {
          await this._activateByEvent(commandActivationEvent(command.command))
          return this._executeContributedCommand(command.command, args)
        },
        metadata,
      }),
    )
  }

  private _registerMenus(menus: Record<string, IMenuContribution[]>): void {
    for (const [key, items] of Object.entries(menus)) {
      const menuId = MENU_ID_BY_KEY[key]
      if (menuId === undefined) {
        console.warn(`[extensions] ignoring unknown menu location: ${key}`)
        continue
      }
      for (const item of items) {
        const { group, order } = parseGroup(item.group)
        this._register(
          MenuRegistry.addMenuItem(menuId, {
            command: item.command,
            ...(item.when !== undefined ? { when: item.when } : {}),
            ...(group !== undefined ? { group } : {}),
            ...(order !== undefined ? { order } : {}),
            ...(item.icon !== undefined ? { icon: item.icon } : {}),
          }),
        )
      }
    }
  }

  private _registerKeybinding(keybinding: IKeybindingContribution): void {
    const strokes = keybinding.key.trim().split(/\s+/)
    const base = {
      command: keybinding.command,
      ...(keybinding.when !== undefined ? { when: keybinding.when } : {}),
    }
    const item: IKeybindingItem =
      strokes.length === 2
        ? { ...base, chords: [strokes[0]!, strokes[1]!] }
        : { ...base, key: keybinding.key }
    this._register(KeybindingsRegistry.registerKeybinding(item))
  }

  private _registerConfiguration(
    extId: string,
    configuration?: IConfigurationContribution | IConfigurationContribution[],
  ): void {
    if (!configuration) return
    const nodes = Array.isArray(configuration) ? configuration : [configuration]
    nodes.forEach((node, index) => {
      this._register(
        ConfigurationRegistry.registerConfiguration({
          id: nodes.length > 1 ? `${extId}.${index}` : extId,
          ...(node.title !== undefined ? { title: node.title } : {}),
          properties: node.properties,
        }),
      )
    })
  }
}
