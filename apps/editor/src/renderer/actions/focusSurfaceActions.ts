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
  IEditorGroupsService,
  ILayoutService,
  IViewsService,
  PartId,
  ViewContainerLocation,
  localize2,
  type IAction2Options,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { isPartFocusedInActiveDocument } from '../services/focus/partFocus.js'
import { focusActiveEditorTabs, holdEditorTabsFocus } from '../workbench/editor/useEditorTabsVim.js'
import { focusViewContainerTabsArea } from '../workbench/paneComposite/viewContainerTabsFocus.js'

interface DefaultContainer {
  readonly location: ViewContainerLocation
  readonly containerId: string
}

abstract class FocusPartAction extends Action2 {
  protected constructor(
    options: IAction2Options,
    private readonly _partId: PartId,
    private readonly _defaultContainer?: DefaultContainer,
  ) {
    super(options)
  }

  override run(accessor: ServicesAccessor): void {
    // Grab every service before the async boundary; the accessor dies there.
    const layoutService = accessor.get(ILayoutService)
    // `focusPart` reveals the part itself, but an empty panel / secondary side
    // bar would still focus a blank surface. Mirror the toggle commands: bring
    // the part up with its default container before moving focus.
    if (!layoutService.getVisible(this._partId)) {
      layoutService.setVisible(this._partId, true)
      if (this._defaultContainer !== undefined) {
        const { location, containerId } = this._defaultContainer
        const viewsService = accessor.get(IViewsService)
        if (!viewsService.getActiveViewContainerId(location)) {
          viewsService.openViewContainer(containerId)
        }
      }
    }
    void layoutService.focusPart(this._partId, { source: 'command' })
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
    super(options(FocusPanelAction.ID, 'Focus Panel'), PartId.Panel, {
      location: ViewContainerLocation.Panel,
      containerId: 'workbench.view.output',
    })
  }
}

export class FocusSecondarySideBarAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusSecondarySideBar'
  constructor() {
    super(
      options(FocusSecondarySideBarAction.ID, 'Focus Secondary Side Bar'),
      PartId.SecondarySideBar,
      {
        location: ViewContainerLocation.SecondarySideBar,
        containerId: 'workbench.view.outline',
      },
    )
  }
}

export class FocusActivityBarAction extends FocusPartAction {
  static readonly ID = 'workbench.action.focusActivityBar'
  constructor() {
    super(options(FocusActivityBarAction.ID, 'Focus Activity Bar'), PartId.ActivityBar)
  }
}

const FOCUSABLE_CONTAINER_PARTS: ReadonlyArray<readonly [PartId, ViewContainerLocation]> = [
  [PartId.SideBar, ViewContainerLocation.SideBar],
  [PartId.SecondarySideBar, ViewContainerLocation.SecondarySideBar],
  [PartId.Panel, ViewContainerLocation.Panel],
]

export class FocusEditorTabsAction extends Action2 {
  static readonly ID = 'workbench.action.focusEditorTabs'
  constructor() {
    super(options(FocusEditorTabsAction.ID, 'Focus Editor Tabs'))
  }

  override run(accessor: ServicesAccessor): void {
    // A freshly opened editor schedules its Monaco focus one frame out. This
    // command's whole point is to move focus to the strip, so hold that intent
    // across the pending pass instead of letting it steal the focus back.
    const group = accessor.get(IEditorGroupsService).activeGroup
    if (!focusActiveEditorTabs()) {
      console.debug('[vim] focusEditorTabs: active group has no tab strip')
      return
    }
    // The strip now owns DOM focus; suppress editor focus until focus actually
    // leaves it (including the two-frame model swap of the active editor).
    holdEditorTabsFocus(group)
  }
}

export class FocusViewContainerTabsAction extends Action2 {
  static readonly ID = 'workbench.action.focusViewContainerTabs'
  constructor() {
    super(options(FocusViewContainerTabsAction.ID, 'Focus View Container Tabs'))
  }

  override run(accessor: ServicesAccessor): void {
    const layoutService = accessor.get(ILayoutService)
    // Prefer the container part the user is already in, then the first visible
    // tabs header (the SideBar's label header has no tabs to focus). Unit-test
    // doubles may not implement `getPart`, so only ask when it exists.
    if (typeof layoutService.getPart === 'function') {
      for (const [partId, location] of FOCUSABLE_CONTAINER_PARTS) {
        if (!isPartFocusedInActiveDocument(layoutService, partId)) continue
        if (focusViewContainerTabsArea(location)) return
      }
    }
    for (const [partId, location] of FOCUSABLE_CONTAINER_PARTS) {
      if (!layoutService.getVisible(partId)) continue
      if (focusViewContainerTabsArea(location)) return
    }
    console.debug('[vim] focusViewContainerTabs: no visible container tab strip')
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
