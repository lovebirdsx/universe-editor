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
  JSONContributionRegistry,
  KeybindingsRegistry,
  KeybindingWeight,
  MenuId,
  MenuRegistry,
  type ICommandMetadata,
  type IJSONSchema,
  type IKeybindingItem,
  type ILogger,
  type IDisposable,
  NullLogger,
} from '@universe-editor/platform'
import {
  commandActivationEvent,
  type ICommandContribution,
  type IConfigurationContribution,
  type ICustomEditorContribution,
  type IExtensionDescriptionDto,
  type IKeybindingContribution,
  type IMenuContribution,
  type IResolvedJsonValidation,
  type ISubmenuContribution,
} from '@universe-editor/extensions-common'

/** Maps VSCode-style manifest menu keys to our internal MenuId. */
const MENU_ID_BY_KEY: Readonly<Record<string, MenuId>> = {
  commandPalette: MenuId.CommandPalette,
  'editor/title': MenuId.EditorTitle,
  'editor/context': MenuId.EditorContext,
  'explorer/context': MenuId.ExplorerContext,
  'view/title': MenuId.ViewTitle,
  'scm/title': MenuId.ScmTitle,
  'scm/resourceState/context': MenuId.ScmResourceStateContext,
  'scm/resourceGroup/context': MenuId.ScmResourceGroupContext,
  'scm/inputBox': MenuId.ScmInputBox,
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
    /** Resolves an http(s) jsonValidation url into an inline schema (renderer-side download). */
    private readonly _resolveRemoteSchema?: (url: string) => Promise<IJSONSchema | undefined>,
    private readonly _logger: ILogger = new NullLogger(),
    /**
     * Bind a contributed custom editor to the editor resolver so matching files
     * open in it. Supplied by ExtensionsContribution (which has DI access);
     * returns a Disposable the translator tracks. Absent in unit tests.
     */
    private readonly _registerCustomEditor?: (editor: ICustomEditorContribution) => IDisposable,
  ) {
    super()
  }

  translate(extensions: readonly IExtensionDescriptionDto[]): void {
    for (const ext of extensions) {
      const contributes = ext.contributes
      // Commands with an explicit `commandPalette` menu declaration opt out of the
      // implicit default entry (VSCode: the declaration — typically `when: false` —
      // overrides the automatic palette listing).
      const explicitPaletteCommands = new Set(
        (contributes.menus?.commandPalette ?? [])
          .map((item) => item.command)
          .filter((id): id is string => id !== undefined),
      )
      for (const command of contributes.commands ?? []) {
        this._registerCommand(command, explicitPaletteCommands.has(command.command))
      }
      if (contributes.menus) {
        this._registerMenus(contributes.menus, contributes.submenus ?? [])
      }
      for (const keybinding of contributes.keybindings ?? []) {
        this._registerKeybinding(keybinding)
      }
      this._registerConfiguration(ext.id, contributes.configuration)
      this._registerJsonValidation(ext.id, contributes.jsonValidation ?? [])
      for (const editor of contributes.customEditors ?? []) {
        this._registerCustomEditorBinding(editor)
      }
    }
  }

  private _registerCustomEditorBinding(editor: ICustomEditorContribution): void {
    if (!this._registerCustomEditor) {
      console.warn(`[extensions] ignoring customEditor "${editor.viewType}": no host wired`)
      return
    }
    this._register(this._registerCustomEditor(editor))
  }

  private _registerCommand(command: ICommandContribution, hasExplicitPaletteEntry: boolean): void {
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
    // VSCode surfaces every contributed command in the command palette by default,
    // unless the extension declared its own `commandPalette` entry (the opt-out path).
    if (!hasExplicitPaletteEntry) {
      this._register(
        MenuRegistry.addMenuItem(MenuId.CommandPalette, {
          command: command.command,
          title: command.title,
          ...(command.category !== undefined ? { group: command.category } : {}),
        }),
      )
    }
  }

  private _registerMenus(
    menus: Record<string, IMenuContribution[]>,
    submenus: readonly ISubmenuContribution[],
  ): void {
    const submenuById = new Map(submenus.map((s) => [s.id, s]))
    for (const [key, items] of Object.entries(menus)) {
      // A menus key is either a well-known location or a declared submenu id
      // (whose children live under the submenu's own id used as a MenuId).
      const menuId = MENU_ID_BY_KEY[key] ?? (submenuById.has(key) ? (key as MenuId) : undefined)
      if (menuId === undefined) {
        console.warn(`[extensions] ignoring unknown menu location: ${key}`)
        continue
      }
      for (const item of items) {
        const { group, order } = parseGroup(item.group)
        if (item.submenu !== undefined) {
          const decl = submenuById.get(item.submenu)
          if (!decl) {
            console.warn(`[extensions] ignoring menu item for unknown submenu: ${item.submenu}`)
            continue
          }
          this._register(
            MenuRegistry.addSubmenuItem(menuId, {
              submenu: item.submenu as MenuId,
              title: decl.label,
              ...(item.when !== undefined ? { when: item.when } : {}),
              ...(group !== undefined ? { group } : {}),
              ...(order !== undefined ? { order } : {}),
              ...(decl.icon !== undefined ? { icon: decl.icon } : {}),
            }),
          )
          continue
        }
        if (item.command === undefined) {
          console.warn(`[extensions] ignoring menu item with neither command nor submenu`)
          continue
        }
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
      weight: KeybindingWeight.ExternalExtension,
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

  private _registerJsonValidation(
    extId: string,
    entries: readonly IResolvedJsonValidation[],
  ): void {
    entries.forEach((entry, index) => {
      const uri = `extension://${extId}/jsonvalidation/${index}`
      const fileMatch = [...entry.fileMatch]
      if (entry.schema !== undefined) {
        this._logger.debug(
          `${extId}: registering inline jsonValidation schema for [${fileMatch.join(', ')}]`,
        )
        this._register(
          JSONContributionRegistry.registerSchema({
            uri,
            fileMatch,
            schema: entry.schema as IJSONSchema,
          }),
        )
        return
      }
      if (entry.url !== undefined) {
        this._registerRemoteJsonValidation(uri, fileMatch, entry.url)
      }
    })
  }

  /**
   * Resolve an http(s) jsonValidation url (renderer-side download) then register
   * the inlined schema. The dispose guard handles the translator being torn down
   * while the async download is still in flight: register only if still live,
   * else dispose the handle immediately to avoid leaking a registration.
   */
  private _registerRemoteJsonValidation(uri: string, fileMatch: string[], url: string): void {
    this._logger.debug(
      `resolving remote jsonValidation schema ${url} for [${fileMatch.join(', ')}]`,
    )
    void this._resolveRemoteSchema?.(url).then((schema) => {
      if (schema === undefined) {
        this._logger.warn(`failed to resolve remote jsonValidation schema ${url}; not registered`)
        return
      }
      const handle = JSONContributionRegistry.registerSchema({ uri, fileMatch, schema })
      if (this._store.isDisposed) handle.dispose()
      else {
        this._register(handle)
        this._logger.debug(`registered remote jsonValidation schema ${url}`)
      }
    })
  }
}
