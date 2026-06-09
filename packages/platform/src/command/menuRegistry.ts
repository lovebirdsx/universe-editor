/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's MenuRegistry (platform/actions/common/actions.ts).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { IContextKeyService } from './contextKey.js'
import { ContextKeyExpr, ContextKeyExpression } from './contextKeyExpr.js'

/**
 * Well-known menu locations. Extend this enum as the editor grows.
 */
export const enum MenuId {
  CommandPalette = 'commandPalette',
  EditorTitle = 'editorTitle',
  EditorContext = 'editorContext',
  EditorTabContext = 'editorTabContext',
  ExplorerContext = 'explorerContext',
  /** ACP chat timeline right-click menu. */
  AcpChatContext = 'acpChatContext',
  TitleBar = 'titleBar',
  StatusBar = 'statusBar',
  SideBarTitle = 'sideBarTitle',
  // Source Control (SCM) menu locations — populated by the Git extension.
  ScmTitle = 'scm/title',
  ScmResourceStateContext = 'scm/resourceState/context',
  ScmResourceGroupContext = 'scm/resourceGroup/context',
  /** Per-view title-bar actions, resolved by a `view == <viewId>` clause. */
  ViewTitle = 'view/title',
  // Title-bar menubar dropdowns
  MenubarFileMenu = 'menubar.file',
  MenubarEditMenu = 'menubar.edit',
  MenubarViewMenu = 'menubar.view',
  MenubarHelpMenu = 'menubar.help',
  // Dynamic submenus
  MenubarFileOpenRecentMenu = 'menubar.file.openRecent',
}

export interface IMenuItem {
  /** The command this menu item triggers. */
  command: string
  /**
   * Optional when-clause expression for conditional visibility.
   * Accepts either a serialized when-clause string or a pre-built AST node.
   * Internally normalized to ContextKeyExpression.
   */
  when?: ContextKeyExpression | string
  /** Menu group (e.g. 'navigation', '1_modification'). Items in the same group are ordered together. */
  group?: string
  /** Order within a group. */
  order?: number
  /** Human-readable title override (falls back to command metadata). */
  title?: string
  /** Optional icon identifier (resolved to a concrete icon by the renderer). */
  icon?: string
}

/**
 * A submenu entry that, when activated, opens another `MenuId`'s items.
 * Submenus are rendered as nested popovers in the MenuBar.
 */
export interface ISubmenuItem {
  /** The MenuId whose items appear as the nested children. */
  submenu: MenuId
  /** Display title (no fallback — submenus don't reference a command). */
  title: string
  when?: ContextKeyExpression | string
  group?: string
  order?: number
  /** Optional icon identifier (resolved to a concrete icon by the renderer). */
  icon?: string
}

export type MenubarEntry = IMenuItem | ISubmenuItem

export function isSubmenuEntry(entry: MenubarEntry): entry is ISubmenuItem {
  return (entry as ISubmenuItem).submenu !== undefined
}

interface IResolvedMenuItem {
  command: string
  when: ContextKeyExpression | undefined
  group?: string
  order?: number
  title?: string
  icon?: string
}

interface IResolvedSubmenuItem {
  submenu: MenuId
  title: string
  when: ContextKeyExpression | undefined
  group?: string
  order?: number
  icon?: string
}

type ResolvedEntry =
  | ({ kind: 'item' } & IResolvedMenuItem)
  | ({ kind: 'submenu' } & IResolvedSubmenuItem)

export interface IMenuRegistry {
  readonly onDidChangeMenu: Event<MenuId>
  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable
  /**
   * Register a submenu under `parent`. The submenu's child items live in
   * `item.submenu`'s MenuId and can be added/removed independently.
   */
  addSubmenuItem(parent: MenuId, item: ISubmenuItem): IDisposable
  /**
   * Returns the entries (commands and submenus, intermixed) for the given
   * location, sorted by (group, order). If `contextKeyService` is provided,
   * entries whose `when` clause evaluates to false are filtered out.
   */
  getMenuItems(menuId: MenuId, contextKeyService?: IContextKeyService): MenubarEntry[]
}

function resolveWhen(when: IMenuItem['when']): ContextKeyExpression | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'string') return ContextKeyExpr.deserialize(when)
  return when
}

class MenuRegistryImpl implements IMenuRegistry {
  private readonly _items = new Map<MenuId, ResolvedEntry[]>()
  private readonly _onDidChangeMenu = new Emitter<MenuId>()

  readonly onDidChangeMenu = this._onDidChangeMenu.event

  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable {
    let items = this._items.get(menuId)
    if (!items) {
      items = []
      this._items.set(menuId, items)
    }
    const resolved: ResolvedEntry = {
      kind: 'item',
      command: item.command,
      when: resolveWhen(item.when),
      ...(item.group !== undefined ? { group: item.group } : {}),
      ...(item.order !== undefined ? { order: item.order } : {}),
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
    }
    items.push(resolved)
    this._onDidChangeMenu.fire(menuId)

    return toDisposable(() => {
      const list = this._items.get(menuId)
      if (list) {
        const idx = list.indexOf(resolved)
        if (idx !== -1) {
          list.splice(idx, 1)
          this._onDidChangeMenu.fire(menuId)
        }
      }
    })
  }

  addSubmenuItem(parent: MenuId, item: ISubmenuItem): IDisposable {
    let items = this._items.get(parent)
    if (!items) {
      items = []
      this._items.set(parent, items)
    }
    const resolved: ResolvedEntry = {
      kind: 'submenu',
      submenu: item.submenu,
      title: item.title,
      when: resolveWhen(item.when),
      ...(item.group !== undefined ? { group: item.group } : {}),
      ...(item.order !== undefined ? { order: item.order } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
    }
    items.push(resolved)
    this._onDidChangeMenu.fire(parent)

    return toDisposable(() => {
      const list = this._items.get(parent)
      if (list) {
        const idx = list.indexOf(resolved)
        if (idx !== -1) {
          list.splice(idx, 1)
          this._onDidChangeMenu.fire(parent)
        }
      }
    })
  }

  getMenuItems(menuId: MenuId, contextKeyService?: IContextKeyService): MenubarEntry[] {
    const items = this._items.get(menuId) ?? []
    const filtered = contextKeyService
      ? items.filter((it) => contextKeyService.contextMatchesRules(it.when))
      : items
    return [...filtered]
      .sort((a, b) => {
        const groupA = a.group ?? ''
        const groupB = b.group ?? ''
        if (groupA !== groupB) {
          return groupA.localeCompare(groupB)
        }
        return (a.order ?? 0) - (b.order ?? 0)
      })
      .map((it) => {
        if (it.kind === 'submenu') {
          return {
            submenu: it.submenu,
            title: it.title,
            ...(it.when !== undefined ? { when: it.when } : {}),
            ...(it.group !== undefined ? { group: it.group } : {}),
            ...(it.order !== undefined ? { order: it.order } : {}),
            ...(it.icon !== undefined ? { icon: it.icon } : {}),
          } as ISubmenuItem
        }
        return {
          command: it.command,
          ...(it.when !== undefined ? { when: it.when } : {}),
          ...(it.group !== undefined ? { group: it.group } : {}),
          ...(it.order !== undefined ? { order: it.order } : {}),
          ...(it.title !== undefined ? { title: it.title } : {}),
          ...(it.icon !== undefined ? { icon: it.icon } : {}),
        } as IMenuItem
      })
  }
}

export const MenuRegistry: IMenuRegistry = new MenuRegistryImpl()
