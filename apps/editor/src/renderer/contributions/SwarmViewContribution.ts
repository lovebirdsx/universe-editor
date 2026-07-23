/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Swarm Reviews ViewContainer (Activity Bar entry) + its single
 *  view. Mirrors ExtensionsViewContribution. The view component (SwarmReviewsView)
 *  reads everything through the perforce extension's contributed commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IStorageService,
  IWorkbenchContribution,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
} from '@universe-editor/platform'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { swarmIgnoreStore } from '../services/swarm/swarmIgnoreStore.js'
import { swarmReviewsUiStore } from '../services/swarm/swarmReviewsUiStore.js'
import { SwarmReviewsView } from '../workbench/swarm/SwarmReviewsView.js'

const REVIEW_WINDOW_DAYS_KEY = 'perforce.swarm.reviewWindowDays'

export class SwarmViewContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IStorageService storage: IStorageService,
    @IConfigurationService configuration: IConfigurationService,
  ) {
    super()

    // Hydrate the persisted client-side stores as early as possible (app start,
    // before the view mounts) so the first render already reflects the ignored
    // set and the saved collapse / keyword state — no flash of an ignored review
    // in "Needs My Action" while hydration catches up.
    void swarmIgnoreStore.attach(storage)
    void swarmReviewsUiStore.attach(storage)

    // Auto-remove ignored reviews that aged out of the review window — the windowed
    // dashboard will never return them again, so they'd pile up in IGNORED forever.
    const pruneExpired = () =>
      swarmIgnoreStore.pruneExpired(configuration.get<number>(REVIEW_WINDOW_DAYS_KEY) ?? 0)
    void swarmIgnoreStore.whenReady.then(pruneExpired)
    this._register(
      configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(REVIEW_WINDOW_DAYS_KEY)) pruneExpired()
      }),
    )

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
