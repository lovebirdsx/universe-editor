/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for the built-in layout commands and the command palette.
 *  Inspired by VSCode's workbench/browser/layoutActions.ts.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  ILayoutService,
  IQuickInputService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  CommandsRegistry,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class ToggleSidebarVisibilityAction extends Action2 {
  static readonly ID = 'workbench.action.toggleSidebarVisibility'
  constructor() {
    super({
      id: ToggleSidebarVisibilityAction.ID,
      title: 'Toggle Primary Side Bar',
      category: 'View',
      keybinding: { primary: 'ctrl+b' },
      menu: { id: MenuId.MenubarViewMenu, group: '2_layout', order: 1 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.SideBar)
  }
}

export class ToggleSecondarySidebarVisibilityAction extends Action2 {
  static readonly ID = 'workbench.action.toggleSecondarySidebarVisibility'
  constructor() {
    super({
      id: ToggleSecondarySidebarVisibilityAction.ID,
      title: 'Toggle Secondary Side Bar',
      category: 'View',
      keybinding: { primary: 'ctrl+alt+b' },
      menu: { id: MenuId.MenubarViewMenu, group: '2_layout', order: 2 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    layoutService.toggleVisible(PartId.SecondarySideBar)
    if (layoutService.getVisible(PartId.SecondarySideBar)) {
      const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.SecondarySideBar)
      if (!activeId) viewsService.openViewContainer('workbench.view.outline')
    }
  }
}

export class TogglePanelAction extends Action2 {
  static readonly ID = 'workbench.action.togglePanel'
  constructor() {
    super({
      id: TogglePanelAction.ID,
      title: 'Toggle Panel',
      category: 'View',
      keybinding: { primary: 'ctrl+j' },
      menu: { id: MenuId.MenubarViewMenu, group: '2_layout', order: 3 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.Panel)
  }
}

export class ShowCommandsAction extends Action2 {
  static readonly ID = 'workbench.action.showCommands'
  constructor() {
    super({
      id: ShowCommandsAction.ID,
      title: 'Show All Commands',
      category: 'View',
      keybinding: { primary: 'ctrl+shift+p' },
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 1 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInputService = accessor.get(IQuickInputService)
    const commandService = accessor.get(ICommandService)
    const commands = [...CommandsRegistry.getCommands().values()].map((cmd) => ({
      id: cmd.id,
      label: cmd.metadata?.description ?? cmd.id,
      ...(cmd.metadata?.category !== undefined ? { description: cmd.metadata.category } : {}),
    }))
    const selected = await quickInputService.pick(commands, {
      id: 'workbench.commandPalette',
      placeholder: 'Type a command name…',
    })
    if (selected) {
      void commandService.executeCommand(selected.id)
    }
  }
}
