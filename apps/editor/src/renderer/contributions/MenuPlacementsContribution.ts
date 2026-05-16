/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Places the built-in commands into the View menu and the command-palette pool.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution, MenuId, MenuRegistry } from '@universe-editor/platform'

export class MenuPlacementsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    // -- View menu
    this._register(
      MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
        command: 'workbench.action.showCommands',
        group: '1_open',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
        command: 'workbench.action.toggleSidebarVisibility',
        group: '2_layout',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
        command: 'workbench.action.toggleSecondarySidebarVisibility',
        group: '2_layout',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
        command: 'workbench.action.togglePanel',
        group: '2_layout',
        order: 3,
      }),
    )

    // -- Command palette pool
    this._register(
      MenuRegistry.addMenuItem(MenuId.CommandPalette, {
        command: 'workbench.action.showCommands',
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.CommandPalette, {
        command: 'workbench.action.toggleSidebarVisibility',
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.CommandPalette, {
        command: 'workbench.action.toggleSecondarySidebarVisibility',
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.CommandPalette, {
        command: 'workbench.action.togglePanel',
      }),
    )
  }
}
