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
        label: 'Explorer',
        icon: 'files',
        order: 1,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.search',
        label: 'Search',
        icon: 'search',
        order: 2,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.outline',
        label: 'Outline',
        icon: 'search',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      }),
    )
  }
}
