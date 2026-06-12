/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for the built-in layout commands and the command palette.
 *  Inspired by VSCode's workbench/browser/layoutActions.ts.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  ILayoutService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IQuickAccessController } from '../services/quickInput/QuickAccessController.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'

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
  override async run(accessor: ServicesAccessor): Promise<void> {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const sidebarVisible = layoutService.getVisible(PartId.SideBar)
    const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
    if (
      sidebarVisible &&
      activeId === 'workbench.view.explorer' &&
      layoutService.getPart(PartId.SideBar)?.isFocused()
    ) {
      layoutService.setVisible(PartId.SideBar, false)
      return
    }
    await layoutService.focusView('workbench.view.explorer.tree', { source: 'command' })
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

export class FocusOutlineAction extends Action2 {
  static readonly ID = 'outline.focus'
  constructor() {
    super({
      id: FocusOutlineAction.ID,
      title: localize('action.focusOutline.title', 'Focus on Outline View'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+q' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor
      .get(ILayoutService)
      .focusView('workbench.view.outline.main', { source: 'command' })
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
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    layoutService.toggleVisible(PartId.Panel)
    if (layoutService.getVisible(PartId.Panel)) {
      const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.Panel)
      if (!activeId) viewsService.openViewContainer('workbench.view.output')
    }
  }
}

export class ToggleMaximizedPanelAction extends Action2 {
  static readonly ID = 'workbench.action.toggleMaximizedPanel'
  constructor() {
    super({
      id: ToggleMaximizedPanelAction.ID,
      title: localize('action.toggleMaximizedPanel.title', 'Toggle Maximized Panel'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'alt+m' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    layoutService.togglePanelMaximized()
    if (layoutService.getVisible(PartId.Panel)) {
      const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.Panel)
      if (!activeId) viewsService.openViewContainer('workbench.view.output')
    }
  }
}

export class ShowScmAction extends Action2 {
  static readonly ID = 'workbench.view.scm'
  constructor() {
    super({
      id: ShowScmAction.ID,
      title: localize('action.showScm.title', 'Show Source Control'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+g' },
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 3 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const sidebarVisible = layoutService.getVisible(PartId.SideBar)
    const activeId = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
    if (
      sidebarVisible &&
      activeId === 'workbench.view.scm' &&
      layoutService.getPart(PartId.SideBar)?.isFocused()
    ) {
      layoutService.setVisible(PartId.SideBar, false)
      return
    }
    // Reveal the active file's row (if any) before focusing, so opening from an
    // editor/diff lands on its change. The diff input maps back to its real file.
    const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
    const fileUri =
      active instanceof FileEditorInput
        ? active.resource
        : active instanceof DiffEditorInput
          ? active.originalUri
          : undefined
    scmViewState.requestReveal(fileUri?.scheme === 'file' ? fileUri.fsPath : null)
    await layoutService.focusView('workbench.view.scm.main', { source: 'command' })
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
    await accessor.get(IQuickAccessController).show('>')
  }
}
