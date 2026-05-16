/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's LayoutActionsContribution (workbench/browser/layoutActions.ts).
 *
 *  Registers the toggle-visibility commands for SideBar / SecondarySideBar / Panel
 *  and their default keybindings.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  ILayoutService,
  IViewsService,
  IWorkbenchContribution,
  KeybindingsRegistry,
  PartId,
  ViewContainerLocation,
} from '@universe-editor/platform'

export class LayoutCommandsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      CommandsRegistry.registerCommand(
        'workbench.action.toggleSidebarVisibility',
        (accessor) => accessor.get(ILayoutService).toggleVisible(PartId.SideBar),
        { description: 'Toggle Primary Side Bar', category: 'View' },
      ),
    )
    this._register(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+b',
        command: 'workbench.action.toggleSidebarVisibility',
      }),
    )

    this._register(
      CommandsRegistry.registerCommand(
        'workbench.action.toggleSecondarySidebarVisibility',
        (accessor) => {
          const layoutService = accessor.get(ILayoutService)
          const viewsService = accessor.get(IViewsService)
          layoutService.toggleVisible(PartId.SecondarySideBar)
          if (layoutService.getVisible(PartId.SecondarySideBar)) {
            const activeId = viewsService.getActiveViewContainerId(
              ViewContainerLocation.SecondarySideBar,
            )
            if (!activeId) viewsService.openViewContainer('workbench.view.outline')
          }
        },
        { description: 'Toggle Secondary Side Bar', category: 'View' },
      ),
    )
    this._register(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+alt+b',
        command: 'workbench.action.toggleSecondarySidebarVisibility',
      }),
    )

    this._register(
      CommandsRegistry.registerCommand(
        'workbench.action.togglePanel',
        (accessor) => accessor.get(ILayoutService).toggleVisible(PartId.Panel),
        { description: 'Toggle Panel', category: 'View' },
      ),
    )
    this._register(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+j',
        command: 'workbench.action.togglePanel',
      }),
    )
  }
}
