/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  View management actions: move a view to another (or new) view container via a
 *  QuickPick. Available on every view's title menu and from the command palette.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  IViewDescriptorService,
  MenuId,
  ViewContainerLocation,
  ViewRegistry,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize('command.category.view', 'View')

const NEW_SIDEBAR = '__new.sidebar__'
const NEW_PANEL = '__new.panel__'
const NEW_SECONDARY = '__new.secondary__'

interface ViewPickItem extends IQuickPickItem {
  readonly viewId: string
}

interface ContainerPickItem extends IQuickPickItem {
  readonly target: string
}

export class MoveViewAction extends Action2 {
  static readonly ID = 'workbench.action.moveView'

  constructor() {
    super({
      id: MoveViewAction.ID,
      title: localize('action.moveView.title', 'Move View'),
      category: CATEGORY,
      icon: 'move',
      menu: [{ id: MenuId.ViewTitle, group: '9_move', order: 1 }],
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, viewId?: unknown): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const viewDescriptors = accessor.get(IViewDescriptorService)

    let sourceViewId = typeof viewId === 'string' ? viewId : undefined

    // Invoked from the command palette without a view → pick the view to move.
    if (!sourceViewId) {
      const viewItems: ViewPickItem[] = ViewRegistry.getAllViews()
        .filter((v) => v.canMoveView !== false)
        .map((v) => {
          const description = viewDescriptors.getViewContainerByViewId(v.id)?.label
          return {
            id: v.id,
            viewId: v.id,
            label: v.name,
            ...(description !== undefined ? { description } : {}),
          }
        })
      if (viewItems.length === 0) return
      const pickedView = await quickInput.pick(viewItems, {
        id: 'workbench.moveView.source',
        placeholder: localize('moveView.source.placeholder', 'Select a view to move'),
      })
      if (!pickedView) return
      sourceViewId = pickedView.viewId
    }

    const view = ViewRegistry.getView(sourceViewId)
    if (!view || view.canMoveView === false) return
    const currentContainerId = viewDescriptors.getViewContainerByViewId(sourceViewId)?.id

    const containerItems: ContainerPickItem[] = []
    for (const location of [
      ViewContainerLocation.SideBar,
      ViewContainerLocation.SecondarySideBar,
      ViewContainerLocation.Panel,
    ]) {
      for (const container of viewDescriptors.getViewContainersByLocation(location)) {
        if (container.id === currentContainerId) continue
        if (container.rejectAddedViews) continue
        containerItems.push({
          id: container.id,
          target: container.id,
          label: container.label,
        })
      }
    }

    containerItems.push(
      {
        id: NEW_SIDEBAR,
        target: NEW_SIDEBAR,
        label: localize('moveView.newSidebar', 'New Container in Primary Side Bar'),
      },
      {
        id: NEW_SECONDARY,
        target: NEW_SECONDARY,
        label: localize('moveView.newSecondary', 'New Container in Secondary Side Bar'),
      },
      {
        id: NEW_PANEL,
        target: NEW_PANEL,
        label: localize('moveView.newPanel', 'New Container in Panel'),
      },
    )

    const picked = await quickInput.pick(containerItems, {
      id: 'workbench.moveView.target',
      placeholder: localize('moveView.target.placeholder', 'Select where to move the view'),
    })
    if (!picked) return

    switch (picked.target) {
      case NEW_SIDEBAR:
        viewDescriptors.moveViewToLocation(sourceViewId, ViewContainerLocation.SideBar)
        break
      case NEW_SECONDARY:
        viewDescriptors.moveViewToLocation(sourceViewId, ViewContainerLocation.SecondarySideBar)
        break
      case NEW_PANEL:
        viewDescriptors.moveViewToLocation(sourceViewId, ViewContainerLocation.Panel)
        break
      default:
        viewDescriptors.moveViewsToContainer([sourceViewId], picked.target)
    }
  }
}

export class ResetViewLocationsAction extends Action2 {
  static readonly ID = 'workbench.action.resetViewLocations'

  constructor() {
    super({
      id: ResetViewLocationsAction.ID,
      title: localize('action.resetViewLocations.title', 'Reset View Locations'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewDescriptorService).reset()
  }
}
