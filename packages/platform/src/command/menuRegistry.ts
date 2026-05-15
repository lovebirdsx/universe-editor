/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's MenuRegistry (platform/actions/common/actions.ts).
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'

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
  /** Optional when-clause key for conditional visibility (simplified: key string). */
  when?: string
  /** Menu group (e.g. 'navigation', '1_modification'). Items in the same group are ordered together. */
  group?: string
  /** Order within a group. */
  order?: number
  /** Human-readable title override (falls back to command metadata). */
  title?: string
}

export interface IMenuRegistry {
  readonly onDidChangeMenu: Event<MenuId>
  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable
  getMenuItems(menuId: MenuId): IMenuItem[]
}

class MenuRegistryImpl implements IMenuRegistry {
  private readonly _items = new Map<MenuId, IMenuItem[]>()
  private readonly _onDidChangeMenu = new Emitter<MenuId>()

  readonly onDidChangeMenu = this._onDidChangeMenu.event

  addMenuItem(menuId: MenuId, item: IMenuItem): IDisposable {
    let items = this._items.get(menuId)
    if (!items) {
      items = []
      this._items.set(menuId, items)
    }
    items.push(item)
    this._onDidChangeMenu.fire(menuId)

    return toDisposable(() => {
      const list = this._items.get(menuId)
      if (list) {
        const idx = list.indexOf(item)
        if (idx !== -1) {
          list.splice(idx, 1)
          this._onDidChangeMenu.fire(menuId)
        }
      }
    })
  }

  getMenuItems(menuId: MenuId): IMenuItem[] {
    const items = this._items.get(menuId) ?? []
    // Sort: by group alphabetically, then by order numerically
    return [...items].sort((a, b) => {
      const groupA = a.group ?? ''
      const groupB = b.group ?? ''
      if (groupA !== groupB) {
        return groupA.localeCompare(groupB)
      }
      return (a.order ?? 0) - (b.order ?? 0)
    })
  }
}

export const MenuRegistry: IMenuRegistry = new MenuRegistryImpl()
