/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Swarm Reviews ViewContainer (Activity Bar entry) + its single
 *  view. Mirrors ExtensionsViewContribution. The view component (SwarmReviewsView)
 *  reads everything through the perforce extension's contributed commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
} from '@universe-editor/platform'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { SwarmReviewsView } from '../workbench/swarm/SwarmReviewsView.js'

export class SwarmViewContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.swarm',
        label: localize('viewContainer.swarm', 'Swarm Reviews'),
        icon: 'git-pull-request',
        // Directly after SCM (order 3), before Session Changes (order 4).
        order: 3.5,
        location: ViewContainerLocation.SideBar,
      }),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.swarm.reviews',
          name: localize('view.swarm.reviews', 'Reviews'),
          containerId: 'workbench.view.swarm',
          icon: 'git-pull-request',
          order: 1,
        },
        SwarmReviewsView,
      ),
    )
  }
}
