/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Surface focus commands used by the Vim leader (`<leader>b/j/t`, group
 *  chords) and the command palette. Part focus is already available; the tab
 *  strip commands are registered here but implemented by the tab-surface work
 *  package (WP4) without touching `actions/index.ts` again.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ILayoutService,
  PartId,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'

abstract class FocusPartAction extends Action2 {
  protected constructor(
    options: IAction2Options,
    private readonly _partId: PartId,
  ) {
    super(options)
  }

  override run(accessor: ServicesAccessor): void {
    // Grab the service before any async boundary; the accessor dies there.
    const layoutService = accessor.get(ILayoutService)
    void layoutService.focusPart(this._partId)
  }
}

const CATEGORY = localize2('command.category.workbench', 'Workbench')

function options(id: string, title: string) {
  return {
    id,
    title: localize2(`action.${id}.title`, title),
    category: CATEGORY,
    f1: true,
  }
}

export class FocusSideBarAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusSideBar'
  constructor() {
    super(options(FocusSideBarAction.ID, 'Focus Side Bar'), PartId.SideBar)
  }
}

export class FocusPanelAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusPanel'
  constructor() {
    super(options(FocusPanelAction.ID, 'Focus Panel'), PartId.Panel)
  }
}

export class FocusSecondarySideBarAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusSecondarySideBar'
  constructor() {
    super(
      options(FocusSecondarySideBarAction.ID, 'Focus Secondary Side Bar'),
      PartId.SecondarySideBar,
    )
  }
}

export class FocusActivityBarAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusActivityBar'
  constructor() {
    super(options(FocusActivityBarAction.ID, 'Focus Activity Bar'), PartId.ActivityBar)
  }
}

export class FocusEditorTabsAction extends Action2 {
  static readonly ID = 'workbench.action.focusEditorTabs'
  constructor() {
    super(options(FocusEditorTabsAction.ID, 'Focus Editor Tabs'))
  }

  override run(_accessor: ServicesAccessor): void {
    // TODO(WP4): focus the active group's tab strip once it registers a tabs surface.
  }
}

export class FocusViewContainerTabsAction extends Action2 {
  static readonly ID = 'workbench.action.focusViewContainerTabs'
  constructor() {
    super(options(FocusViewContainerTabsAction.ID, 'Focus View Container Tabs'))
  }

  override run(_accessor: ServicesAccessor): void {
    // TODO(WP4): focus the active view container's header tabs.
  }
}

export const FOCUS_SURFACE_ACTIONS = [
  FocusSideBarAction,
  FocusPanelAction,
  FocusSecondarySideBarAction,
  FocusActivityBarAction,
  FocusEditorTabsAction,
  FocusViewContainerTabsAction,
] as const
