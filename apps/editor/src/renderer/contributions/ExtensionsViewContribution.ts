/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Extensions ViewContainer (Activity Bar entry) + its single view.
 *  Mirrors VSCode's Extensions viewlet. The view component (ExtensionsView) reads
 *  everything through IExtensionsWorkbenchService.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
} from '@universe-editor/platform'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { ExtensionsView } from '../workbench/extensions/ExtensionsView.js'

export class ExtensionsViewContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.extensions',
        label: localize('viewContainer.extensions', 'Extensions'),
        icon: 'extensions',
        order: 6,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.extensions.main',
          name: localize('view.extensions', 'Extensions'),
          containerId: 'workbench.view.extensions',
          icon: 'extensions',
          order: 1,
        },
        ExtensionsView,
      ),
    )
  }
}
