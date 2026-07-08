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
  localize2,
  type LayoutSizes,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IQuickAccessController } from '../services/quickInput/QuickAccessController.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'
import {
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  PANEL_MIN,
  PANEL_MAX,
  RESIZE_STEP,
} from '../services/layout/layoutConstraints.js'

export class ShowExplorerAction extends Action2 {
  static readonly ID = 'workbench.view.explorer'
  constructor() {
    super({
      id: ShowExplorerAction.ID,
      title: localize2('action.showExplorer.title', 'Show Explorer'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.toggleActivityBar.title', 'Toggle Activity Bar'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.togglePrimarySideBar.title', 'Toggle Primary Side Bar'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.toggleSecondarySideBar.title', 'Toggle Secondary Side Bar'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.focusOutline.title', 'Focus on Outline View'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.togglePanel.title', 'Toggle Panel'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.toggleMaximizedPanel.title', 'Toggle Maximized Panel'),
      category: localize2('command.category.view', 'View'),
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
      title: localize2('action.showScm.title', 'Show Source Control'),
      category: localize2('command.category.view', 'View'),
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

export class ShowExtensionsViewAction extends Action2 {
  static readonly ID = 'workbench.view.extensions'
  constructor() {
    super({
      id: ShowExtensionsViewAction.ID,
      title: localize2('action.showExtensions.title', 'Show Extensions'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+x' },
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 4 },
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
      activeId === 'workbench.view.extensions' &&
      layoutService.getPart(PartId.SideBar)?.isFocused()
    ) {
      layoutService.setVisible(PartId.SideBar, false)
      return
    }
    await layoutService.focusView('workbench.view.extensions.main', { source: 'command' })
  }
}

export class ShowCommandsAction extends Action2 {
  static readonly ID = 'workbench.action.showCommands'
  constructor() {
    super({
      id: ShowCommandsAction.ID,
      title: localize2('action.showAllCommands.title', 'Show All Commands'),
      category: localize2('command.category.view', 'View'),
      keybinding: [{ primary: 'ctrl+shift+p' }, { primary: 'f1' }],
      menu: { id: MenuId.MenubarViewMenu, group: '1_open', order: 1 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IQuickAccessController).show('>')
  }
}

// -- Keyboard resize of the focused part -------------------------------------
//
// `ctrl+alt+shift+{right,left,down,up}` grows/shrinks whichever resizable part
// currently holds focus. Direction semantics are uniform: right/down enlarge,
// left/up shrink (matches VSCode's increase/decrease View Width/Height).

const RESIZE_WHEN = 'sideBarFocus || secondarySideBarFocus || panelFocus || editorAreaFocus'

const RESIZABLE_PARTS = [
  PartId.SideBar,
  PartId.SecondarySideBar,
  PartId.Panel,
  PartId.EditorArea,
] as const

function focusedResizablePart(layout: ILayoutService): PartId | undefined {
  for (const id of RESIZABLE_PARTS) {
    if (layout.getPart(id)?.isFocused()) return id
  }
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function setClamped(
  layout: ILayoutService,
  key: keyof LayoutSizes,
  value: number,
  min: number,
  max: number,
): void {
  layout.setSize(key, clamp(value, min, max))
}

// Editor and Panel share the center column's width. Growing the center
// (delta > 0) shrinks the secondary sidebar, or the primary sidebar when the
// secondary is hidden; no-op when both are hidden.
function resizeCenterWidth(layout: ILayoutService, delta: 1 | -1): void {
  const sizes = layout.sizes.get()
  const step = RESIZE_STEP * delta
  if (layout.getVisible(PartId.SecondarySideBar)) {
    setClamped(layout, 'secondarySidebar', sizes.secondarySidebar - step, SIDEBAR_MIN, SIDEBAR_MAX)
  } else if (layout.getVisible(PartId.SideBar)) {
    setClamped(layout, 'sidebar', sizes.sidebar - step, SIDEBAR_MIN, SIDEBAR_MAX)
  }
}

function resizeFocusedPart(
  accessor: ServicesAccessor,
  dim: 'width' | 'height',
  delta: 1 | -1,
): void {
  const layout = accessor.get(ILayoutService)
  const part = focusedResizablePart(layout)
  if (!part) return
  const sizes = layout.sizes.get()
  const step = RESIZE_STEP * delta
  switch (part) {
    case PartId.SideBar:
      if (dim === 'width')
        setClamped(layout, 'sidebar', sizes.sidebar + step, SIDEBAR_MIN, SIDEBAR_MAX)
      return
    case PartId.SecondarySideBar:
      if (dim === 'width')
        setClamped(
          layout,
          'secondarySidebar',
          sizes.secondarySidebar + step,
          SIDEBAR_MIN,
          SIDEBAR_MAX,
        )
      return
    case PartId.Panel:
      if (dim === 'height') setClamped(layout, 'panel', sizes.panel + step, PANEL_MIN, PANEL_MAX)
      else resizeCenterWidth(layout, delta)
      return
    case PartId.EditorArea:
      // Editor taller = panel shorter (and vice versa).
      if (dim === 'height') setClamped(layout, 'panel', sizes.panel - step, PANEL_MIN, PANEL_MAX)
      else resizeCenterWidth(layout, delta)
      return
  }
}

export class IncreaseViewWidthAction extends Action2 {
  static readonly ID = 'workbench.action.increaseViewWidth'
  constructor() {
    super({
      id: IncreaseViewWidthAction.ID,
      title: localize2('action.increaseViewWidth.title', 'Increase Current View Width'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+alt+shift+right', when: RESIZE_WHEN },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resizeFocusedPart(accessor, 'width', 1)
  }
}

export class DecreaseViewWidthAction extends Action2 {
  static readonly ID = 'workbench.action.decreaseViewWidth'
  constructor() {
    super({
      id: DecreaseViewWidthAction.ID,
      title: localize2('action.decreaseViewWidth.title', 'Decrease Current View Width'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+alt+shift+left', when: RESIZE_WHEN },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resizeFocusedPart(accessor, 'width', -1)
  }
}

export class IncreaseViewHeightAction extends Action2 {
  static readonly ID = 'workbench.action.increaseViewHeight'
  constructor() {
    super({
      id: IncreaseViewHeightAction.ID,
      title: localize2('action.increaseViewHeight.title', 'Increase Current View Height'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+alt+shift+down', when: RESIZE_WHEN },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resizeFocusedPart(accessor, 'height', 1)
  }
}

export class DecreaseViewHeightAction extends Action2 {
  static readonly ID = 'workbench.action.decreaseViewHeight'
  constructor() {
    super({
      id: DecreaseViewHeightAction.ID,
      title: localize2('action.decreaseViewHeight.title', 'Decrease Current View Height'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+alt+shift+up', when: RESIZE_WHEN },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resizeFocusedPart(accessor, 'height', -1)
  }
}
