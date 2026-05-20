/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for the built-in layout commands and the command palette.
 *  Inspired by VSCode's workbench/browser/layoutActions.ts.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IEditorGroupsService,
  ILayoutService,
  IQuickInputService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  CommandsRegistry,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  collectMonacoCommands,
  isMonacoCommandItem,
  type MonacoCommandItem,
} from '../services/quickInput/monacoCommandSource.js'
import { resolveShortcut } from '../workbench/titlebar/keybindingFormat.js'

export const EXPLORER_FOCUS_VIEW_EVENT = 'explorer:focus-view'

export class ShowExplorerAction extends Action2 {
  static readonly ID = 'workbench.view.explorer'
  constructor() {
    super({
      id: ShowExplorerAction.ID,
      title: localize('action.showExplorer.title', 'Show Explorer'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+e' },
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 2 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const sidebarVisible = layoutService.getVisible(PartId.SideBar)
    const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
    const dispatchFocus = () => {
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent(EXPLORER_FOCUS_VIEW_EVENT))
      }
    }
    if (sidebarVisible && activeId === 'workbench.view.explorer') {
      if (layoutService.getPart(PartId.SideBar)?.isFocused()) {
        layoutService.setVisible(PartId.SideBar, false)
      } else {
        layoutService.getPart(PartId.SideBar)?.focus()
        dispatchFocus()
      }
    } else {
      viewsService.openViewContainer('workbench.view.explorer')
      if (!sidebarVisible) {
        layoutService.setVisible(PartId.SideBar, true)
      }
      layoutService.getPart(PartId.SideBar)?.focus()
      dispatchFocus()
    }
  }
}

export class ToggleActivityBarVisibilityAction extends Action2 {
  static readonly ID = 'workbench.action.toggleActivityBarVisibility'
  constructor() {
    super({
      id: ToggleActivityBarVisibilityAction.ID,
      title: localize('action.toggleActivityBar.title', 'Toggle Activity Bar'),
      category: localize('command.category.view', 'View'),
      menu: { id: MenuId.MenubarViewMenu, group: '2_layout', order: 0 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.ActivityBar)
  }
}

export class ToggleSidebarVisibilityAction extends Action2 {
  static readonly ID = 'workbench.action.toggleSidebarVisibility'
  constructor() {
    super({
      id: ToggleSidebarVisibilityAction.ID,
      title: localize('action.togglePrimarySideBar.title', 'Toggle Primary Side Bar'),
      category: localize('command.category.view', 'View'),
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
      title: localize('action.toggleSecondarySideBar.title', 'Toggle Secondary Side Bar'),
      category: localize('command.category.view', 'View'),
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
      title: localize('action.togglePanel.title', 'Toggle Panel'),
      category: localize('command.category.view', 'View'),
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
      title: localize('action.showAllCommands.title', 'Show All Commands'),
      category: localize('command.category.view', 'View'),
      keybinding: [{ primary: 'ctrl+shift+p' }, { primary: 'f1' }],
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 1 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInputService = accessor.get(IQuickInputService)
    const commandService = accessor.get(ICommandService)
    const groupsService = accessor.get(IEditorGroupsService)

    const registryItems: IQuickPickItem[] = [...CommandsRegistry.getCommands().values()].map(
      (cmd) => {
        const keybinding = resolveShortcut(cmd.id)
        return {
          id: cmd.id,
          label: cmd.metadata?.description ?? cmd.id,
          ...(cmd.metadata?.category !== undefined ? { description: cmd.metadata.category } : {}),
          ...(keybinding !== undefined ? { keybinding } : {}),
        }
      },
    )
    const monacoItems: MonacoCommandItem[] = collectMonacoCommands(groupsService)
    // De-dupe: a Monaco action id can collide with a project command id; prefer
    // the project command (project intent wins, Monaco is a fallback source).
    const projectIds = new Set(registryItems.map((i) => i.id))
    const items: IQuickPickItem[] = [
      ...registryItems,
      ...monacoItems.filter((m) => !projectIds.has(m.id)),
    ]

    const selected = await quickInputService.pick(items, {
      id: 'workbench.commandPalette',
      placeholder: localize('quickInput.commandPalette.placeholder', 'Type a command name…'),
      prefix: '>',
    })
    if (!selected) return
    if (isMonacoCommandItem(selected)) {
      void selected._editor.getAction(selected._actionId)?.run()
    } else {
      void commandService.executeCommand(selected.id)
    }
  }
}
