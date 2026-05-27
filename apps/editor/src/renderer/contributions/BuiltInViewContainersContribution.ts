/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers built-in ViewContainers: Explorer (Primary Side Bar) and Outline
 *  (Secondary Side Bar). Extensions register their own containers later via the
 *  same `ViewContainerRegistry` API.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
} from '@universe-editor/platform'

export class BuiltInViewContainersContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.explorer',
        label: localize('viewContainer.explorer', 'Explorer'),
        icon: 'files',
        order: 1,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.search',
        label: localize('viewContainer.search', 'Search'),
        icon: 'search',
        order: 2,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.outline',
        label: localize('viewContainer.outline', 'Outline'),
        icon: 'outline',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      }),
    )

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.output',
        label: localize('viewContainer.output', 'Output'),
        icon: 'output',
        order: 1,
        location: ViewContainerLocation.Panel,
      }),
    )
  }
}
