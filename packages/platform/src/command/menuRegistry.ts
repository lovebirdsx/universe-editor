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
  TitleBar = 'titleBar',
  StatusBar = 'statusBar',
  SideBarTitle = 'sideBarTitle',
  // Title-bar menubar dropdowns
  MenubarFileMenu = 'menubar.file',
  MenubarEditMenu = 'menubar.edit',
  MenubarViewMenu = 'menubar.view',
  MenubarHelpMenu = 'menubar.help',
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
}

interface IResolvedMenuItem {
  command: string
  when: ContextKeyExpression | undefined
  group?: string
  order?: number
  title?: string
}

export interface IMenuRegistry {
  readonly onDidChangeMenu: Event<MenuId>
  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable
  /**
   * Returns the menu items for the given location, sorted by (group, order).
   * If `contextKeyService` is provided, items whose `when` clause evaluates to
   * false against the current context are filtered out.
   */
  getMenuItems(menuId: MenuId, contextKeyService?: IContextKeyService): IMenuItem[]
}

function resolveWhen(when: IMenuItem['when']): ContextKeyExpression | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'string') return ContextKeyExpr.deserialize(when)
  return when
}

class MenuRegistryImpl implements IMenuRegistry {
  private readonly _items = new Map<MenuId, IResolvedMenuItem[]>()
  private readonly _onDidChangeMenu = new Emitter<MenuId>()

  readonly onDidChangeMenu = this._onDidChangeMenu.event

  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable {
    let items = this._items.get(menuId)
    if (!items) {
      items = []
      this._items.set(menuId, items)
    }
    const resolved: IResolvedMenuItem = {
      command: item.command,
      when: resolveWhen(item.when),
      ...(item.group !== undefined ? { group: item.group } : {}),
      ...(item.order !== undefined ? { order: item.order } : {}),
      ...(item.title !== undefined ? { title: item.title } : {}),
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

  getMenuItems(menuId: MenuId, contextKeyService?: IContextKeyService): IMenuItem[] {
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
      .map((it) => ({
        command: it.command,
        ...(it.when !== undefined ? { when: it.when } : {}),
        ...(it.group !== undefined ? { group: it.group } : {}),
        ...(it.order !== undefined ? { order: it.order } : {}),
        ...(it.title !== undefined ? { title: it.title } : {}),
      }))
  }
}

export const MenuRegistry: IMenuRegistry = new MenuRegistryImpl()
