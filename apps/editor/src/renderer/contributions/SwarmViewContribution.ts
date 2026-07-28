/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Swarm Reviews ViewContainer (Activity Bar entry) + its single
 *  view. Mirrors ExtensionsViewContribution. The view component (SwarmReviewsView)
 *  reads everything through the perforce extension's contributed commands.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  combinedDisposable,
  Disposable,
  IConfigurationService,
  IStorageService,
  IWorkbenchContribution,
  localize,
  MutableDisposable,
  ViewContainerLocation,
  ViewContainerRegistry,
} from '@universe-editor/platform'
import { IScmService } from '../services/extensions/ScmService.js'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { swarmIgnoreStore } from '../services/swarm/swarmIgnoreStore.js'
import { swarmApplyStore } from '../services/swarm/swarmApplyStore.js'
import { swarmReviewsUiStore } from '../services/swarm/swarmReviewsUiStore.js'
import { SwarmReviewsView } from '../workbench/swarm/SwarmReviewsView.js'

const REVIEW_WINDOW_DAYS_KEY = 'perforce.swarm.reviewWindowDays'

export class SwarmViewContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IStorageService storage: IStorageService,
    @IConfigurationService configuration: IConfigurationService,
    @IScmService scmService: IScmService,
  ) {
    super()

    // Hydrate the persisted client-side stores as early as possible (app start,
    // before the view mounts) so the first render already reflects the ignored
    // set and the saved collapse / keyword state — no flash of an ignored review
    // in "Needs My Action" while hydration catches up.
    void swarmIgnoreStore.attach(storage)
    void swarmReviewsUiStore.attach(storage)
    void swarmApplyStore.attach(storage)

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

    // Register the container only while a perforce source control exists (the
    // extension activated for this workspace). Swarm reviews are meaningless
    // outside a Perforce workspace, so the whole entry point disappears from
    // the Activity Bar instead of rendering an unusable view. The holder is
    // registered on this contribution so the leak tracker roots the dynamic
    // registrations through it (a plain closure variable would be reported).
    const registrations = this._register(new MutableDisposable())
    this._register(
      autorun((r) => {
        const hasPerforce = scmService.sourceControls.read(r).some((sc) => sc.id === 'perforce')
        if (hasPerforce && !registrations.value) {
          registrations.value = combinedDisposable(
            ViewContainerRegistry.registerViewContainer({
              id: 'workbench.view.swarm',
              label: localize('viewContainer.swarm', 'Swarm Reviews'),
              icon: 'git-pull-request',
              // Directly after SCM (order 3), before Session Changes (order 4).
              order: 3.5,
              location: ViewContainerLocation.SideBar,
            }),
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
        } else if (!hasPerforce) {
          registrations.clear()
        }
      }),
    )
  }
}
