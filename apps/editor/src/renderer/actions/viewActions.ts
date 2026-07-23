/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  View management actions. Moving views / containers is done by dragging their
 *  title bar or activity-bar icon (see workbench/dnd); the only command left is a
 *  reset back to registry defaults.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ILayoutService,
  IViewDescriptorService,
  IViewsService,
  KeybindingWeight,
  PartId,
  ViewContainerLocation,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize2('command.category.view', 'View')

export class ResetViewLocationsAction extends Action2 {
  static readonly ID = 'workbench.action.resetViewLocations'

  constructor() {
    super({
      id: ResetViewLocationsAction.ID,
      title: localize2('action.resetViewLocations.title', 'Reset View Locations'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewDescriptorService).reset()
  }
}

// Ctrl+PageUp/PageDown cycles the view containers of whichever view-container
// part currently holds focus, mirroring how the same keys cycle editors in the
// active editor group. The weight (above the default WorkbenchContrib) makes
// these scoped bindings beat nextEditor/previousEditor whenever one of the
// focus keys below holds, regardless of registration order; with editor-area
// focus the when-clause fails and editor cycling keeps working.
const CONTAINER_CYCLE_WHEN = 'sideBarFocus || secondarySideBarFocus || panelFocus'
const CONTAINER_CYCLE_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

const LOCATION_BY_PART: ReadonlyArray<readonly [PartId, ViewContainerLocation]> = [
  [PartId.SideBar, ViewContainerLocation.SideBar],
  [PartId.SecondarySideBar, ViewContainerLocation.SecondarySideBar],
  [PartId.Panel, ViewContainerLocation.Panel],
]

async function cycleViewContainer(accessor: ServicesAccessor, delta: 1 | -1): Promise<void> {
  // Capture everything synchronously — the accessor invalidates after await.
  const layoutService = accessor.get(ILayoutService)
  const viewsService = accessor.get(IViewsService)
  const viewDescriptors = accessor.get(IViewDescriptorService)

  let location: ViewContainerLocation | undefined
  for (const [partId, loc] of LOCATION_BY_PART) {
    if (layoutService.getPart(partId)?.isFocused()) {
      location = loc
      break
    }
  }
  if (location === undefined) return

  const containers = viewDescriptors.getViewContainersByLocation(location)
  if (containers.length < 2) return

  const activeId = viewsService.getActiveViewContainerId(location)
  const idx = containers.findIndex((c) => c.id === activeId)
  const nextIdx =
    idx === -1
      ? delta > 0
        ? 0
        : containers.length - 1
      : (idx + delta + containers.length) % containers.length
  const target = containers[nextIdx]!

  const firstViewId = viewDescriptors.getViewsByContainer(target.id)[0]?.id
  if (!firstViewId) {
    viewsService.openViewContainer(target.id)
    return
  }
  await layoutService.focusView(firstViewId, { source: 'command' })
}

export class NextViewContainerAction extends Action2 {
  static readonly ID = 'workbench.action.nextViewContainer'

  constructor() {
    super({
      id: NextViewContainerAction.ID,
      title: localize2('action.nextViewContainer.title', 'Open Next View Container'),
      category: CATEGORY,
      keybinding: {
        primary: 'ctrl+pagedown',
        when: CONTAINER_CYCLE_WHEN,
        weight: CONTAINER_CYCLE_KEY_WEIGHT,
      },
      precondition: CONTAINER_CYCLE_WHEN,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await cycleViewContainer(accessor, 1)
  }
}

export class PreviousViewContainerAction extends Action2 {
  static readonly ID = 'workbench.action.previousViewContainer'

  constructor() {
    super({
      id: PreviousViewContainerAction.ID,
      title: localize2('action.previousViewContainer.title', 'Open Previous View Container'),
      category: CATEGORY,
      keybinding: {
        primary: 'ctrl+pageup',
        when: CONTAINER_CYCLE_WHEN,
        weight: CONTAINER_CYCLE_KEY_WEIGHT,
      },
      precondition: CONTAINER_CYCLE_WHEN,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await cycleViewContainer(accessor, -1)
  }
}
