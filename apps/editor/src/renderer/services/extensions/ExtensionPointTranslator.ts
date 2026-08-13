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
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
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
  type IGrammarContribution,
  type IIconThemeContribution,
  type IKeybindingContribution,
  type IMenuContribution,
  type IProductIconThemeContribution,
  type IResolvedJsonValidation,
  type ISubmenuContribution,
  type IThemeContribution,
  type IViewContribution,
} from '@universe-editor/extensions-common'
import { registerCommandSource } from './contributedCommandSources.js'
import { EXTENSION_TREE_VIEW_COMPONENT_KEY } from '../views/extensionViews.js'

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
  'scm/resourceFolder/context': MenuId.ScmResourceFolderContext,
  'scm/inputBox': MenuId.ScmInputBox,
  'timeline/item/context': MenuId.TimelineItemContext,
  'view/item/context': MenuId.ViewItemContext,
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

/**
 * Maps the VSCode-style `contributes.views` keys for well-known built-in
 * containers to our container ids. A key not listed here is tried verbatim as a
 * container id (so extensions may also target any container by its full id).
 */
const BUILTIN_CONTAINER_ID_BY_VIEWS_KEY: Readonly<Record<string, string>> = {
  explorer: 'workbench.view.explorer',
  search: 'workbench.view.search',
  scm: 'workbench.view.scm',
  outline: 'workbench.view.outline',
}

/**
 * Order spacing for extension containers within the contributed tier. The
 * registry also sorts by tier (built-in before contributed, see
 * IViewContainerDescriptor.contributed), so this base no longer carries the
 * layering invariant — it just spaces out per-extension slots.
 */
const EXTENSION_CONTAINER_ORDER_BASE = 100

/** Strips the `$(name)` codicon-reference wrapper VSCode manifests use. */
function normalizeContainerIcon(icon: string): string {
  const match = /^\$\(([\w-]+)\)$/.exec(icon)
  return match?.[1] ?? icon
}

/** Context the translator passes to the theme-registration callback. */
export interface IThemeRegistrationContext {
  readonly extensionId: string
  readonly extensionLocation: string
  readonly extensionIsBuiltin: boolean
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
    /**
     * Register a batch of `contributes.themes` entries into the color theme
     * registry. Supplied by ExtensionsContribution; absent in unit tests.
     */
    private readonly _registerThemes?: (
      themes: readonly IThemeContribution[],
      context: IThemeRegistrationContext,
    ) => IDisposable,
    /**
     * Register a batch of `contributes.iconThemes` entries into the file icon
     * theme registry. Supplied by ExtensionsContribution; absent in unit tests.
     */
    private readonly _registerIconThemes?: (
      themes: readonly IIconThemeContribution[],
      context: IThemeRegistrationContext,
    ) => IDisposable,
    /**
     * Register a batch of `contributes.productIconThemes` entries into the
     * product icon theme registry. Supplied by ExtensionsContribution; absent
     * in unit tests.
     */
    private readonly _registerProductIconThemes?: (
      themes: readonly IProductIconThemeContribution[],
      context: IThemeRegistrationContext,
    ) => IDisposable,
    /**
     * Register a batch of `contributes.grammars` entries into the grammar
     * registry (TextMate tokenization). Supplied by ExtensionsContribution;
     * absent in unit tests.
     */
    private readonly _registerGrammars?: (
      grammars: readonly IGrammarContribution[],
      context: IThemeRegistrationContext,
    ) => IDisposable,
  ) {
    super()
  }

  translate(extensions: readonly IExtensionDescriptionDto[]): void {
    // Containers land before any views so a view targeting a container declared
    // by ANOTHER extension resolves regardless of host scan order (VSCode:
    // viewsContainers and views are separate contribution points).
    this._registerViewContainers(extensions)
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
        this._registerCommand(ext, command, explicitPaletteCommands.has(command.command))
      }
      if (contributes.menus) {
        this._registerMenus(contributes.menus, contributes.submenus ?? [])
      }
      for (const keybinding of contributes.keybindings ?? []) {
        this._registerKeybinding(ext, keybinding)
      }
      this._registerConfiguration(ext.id, contributes.configuration)
      this._registerJsonValidation(ext.id, contributes.jsonValidation ?? [])
      this._registerViews(ext, contributes.views)
      for (const editor of contributes.customEditors ?? []) {
        this._registerCustomEditorBinding(editor)
      }
      const themeContext: IThemeRegistrationContext = {
        extensionId: ext.id,
        extensionLocation: ext.extensionLocation,
        extensionIsBuiltin: ext.extensionIsBuiltin,
      }
      this._registerContributionBatch(contributes.themes, this._registerThemes, themeContext)
      this._registerContributionBatch(
        contributes.iconThemes,
        this._registerIconThemes,
        themeContext,
      )
      this._registerContributionBatch(
        contributes.productIconThemes,
        this._registerProductIconThemes,
        themeContext,
      )
      this._registerContributionBatch(contributes.grammars, this._registerGrammars, themeContext)
    }
  }

  /**
   * Register one batch of theme-family contributions (color / file-icon /
   * product-icon themes, grammars): an absent/empty batch or an unwired registry
   * (unit tests) is a no-op; a returned handle is tracked for teardown.
   */
  private _registerContributionBatch<T>(
    batch: readonly T[] | undefined,
    register:
      | ((batch: readonly T[], context: IThemeRegistrationContext) => IDisposable | undefined)
      | undefined,
    context: IThemeRegistrationContext,
  ): void {
    if (batch === undefined || batch.length === 0 || register === undefined) return
    const handle = register(batch, context)
    if (handle !== undefined) this._register(handle)
  }

  private _registerCustomEditorBinding(editor: ICustomEditorContribution): void {
    if (!this._registerCustomEditor) {
      console.warn(`[extensions] ignoring customEditor "${editor.viewType}": no host wired`)
      return
    }
    this._register(this._registerCustomEditor(editor))
  }

  /**
   * Register every extension's `contributes.viewsContainers` in one pass ordered
   * by extension id, allocating activity-bar order slots from a single counter:
   * each container gets a distinct slot and the slots are stable across
   * restarts that scan the same install set in a different order.
   */
  private _registerViewContainers(extensions: readonly IExtensionDescriptionDto[]): void {
    const sorted = [...extensions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    let orderIndex = 0
    for (const ext of sorted) {
      for (const container of ext.contributes.viewsContainers?.activitybar ?? []) {
        if (ViewContainerRegistry.getViewContainer(container.id) !== undefined) {
          this._logger.warn(
            `${ext.id}: ignoring viewsContainer "${container.id}": id already registered`,
          )
          continue
        }
        this._register(
          ViewContainerRegistry.registerViewContainer({
            id: container.id,
            label: container.title,
            icon: normalizeContainerIcon(container.icon),
            order: EXTENSION_CONTAINER_ORDER_BASE + orderIndex,
            location: ViewContainerLocation.SideBar,
            contributed: true,
          }),
        )
        orderIndex += 1
      }
    }
  }

  /**
   * Translate `contributes.views` into the view registry (containers were all
   * registered up front, so a key may also resolve to one declared by another
   * extension). Every extension view shares one static componentKey; the bound
   * component receives the view id via props and activates the owner on first
   * reveal. A `views` key resolves to a well-known built-in alias or any
   * registered container id verbatim; anything else is skipped with a warning
   * (mirrors the unknown menu-location policy). The view-level `when` clause is
   * carried onto the descriptor; IViewDescriptorService gates visibility on it,
   * re-evaluating as the referenced context keys change.
   */
  private _registerViews(
    ext: IExtensionDescriptionDto,
    views: Record<string, IViewContribution[]> | undefined,
  ): void {
    for (const [key, entries] of Object.entries(views ?? {})) {
      const containerId = this._resolveViewsContainerKey(key)
      if (containerId === undefined) {
        this._logger.warn(`${ext.id}: ignoring views for unknown container: ${key}`)
        continue
      }
      entries.forEach((view, index) => {
        if (ViewRegistry.getView(view.id) !== undefined) {
          this._logger.warn(`${ext.id}: ignoring view "${view.id}": id already registered`)
          return
        }
        this._register(
          ViewRegistry.registerView({
            id: view.id,
            name: view.name,
            containerId,
            componentKey: EXTENSION_TREE_VIEW_COMPONENT_KEY,
            order: index,
            ...(view.when !== undefined ? { when: view.when } : {}),
          }),
        )
      })
    }
  }

  private _resolveViewsContainerKey(key: string): string | undefined {
    const builtin = BUILTIN_CONTAINER_ID_BY_VIEWS_KEY[key]
    if (builtin !== undefined && ViewContainerRegistry.getViewContainer(builtin) !== undefined) {
      return builtin
    }
    if (ViewContainerRegistry.getViewContainer(key) !== undefined) return key
    return undefined
  }

  private _registerCommand(
    ext: IExtensionDescriptionDto,
    command: ICommandContribution,
    hasExplicitPaletteEntry: boolean,
  ): void {
    // A command id the core already registered (a built-in Action2, e.g. the git
    // blame toggles) stays core-owned: installing a bootstrap proxy on top would
    // shadow the real handler and route execution to a host that doesn't implement
    // it. Mirrors the same guard in MainThreadCommands.$registerCommand.
    if (CommandsRegistry.getCommand(command.command)) return
    this._register(registerCommandSource(command.command, ext.id))
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

  private _registerKeybinding(
    ext: IExtensionDescriptionDto,
    keybinding: IKeybindingContribution,
  ): void {
    this._register(registerCommandSource(keybinding.command, ext.id))
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
