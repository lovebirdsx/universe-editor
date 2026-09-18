/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the Swarm Reviews ViewContainer (Activity Bar entry) + its two
 *  views (Reviews, Swarm Changes). Mirrors ExtensionsViewContribution. The view
 *  components read everything through the perforce extension's contributed
 *  commands.
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
  observableValue,
  ViewContainerLocation,
  ViewContainerRegistry,
} from '@universe-editor/platform'
import {
  SWARM_CHANGES_VIEW_ID,
  SWARM_CONTAINER_ID,
  SWARM_REVIEWS_VIEW_ID,
} from '../actions/swarmActions.js'
import { IScmService } from '../services/extensions/ScmService.js'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { swarmIgnoreStore } from '../services/swarm/swarmIgnoreStore.js'
import { swarmApplyStore } from '../services/swarm/swarmApplyStore.js'
import { swarmReviewsUiStore } from '../services/swarm/swarmReviewsUiStore.js'
import { swarmNeedsActionCount } from '../services/swarm/swarmViewState.js'
import { SwarmReviewsView } from '../workbench/swarm/SwarmReviewsView.js'
import { SwarmChangesView } from '../workbench/swarm/SwarmChangesView.js'
import { SwarmChangesViewToolbar } from '../workbench/swarm/SwarmChangesViewToolbar.js'

const REVIEW_WINDOW_DAYS_KEY = 'perforce.swarm.reviewWindowDays'
const SWARM_ENABLED_KEY = 'perforce.swarm.enabled'

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

    // `perforce.swarm.enabled` drives registration alongside the SCM presence.
    // IConfigurationService is event-based (no observable), so mirror it into one
    // for the autorun below. Any non-false value counts as enabled (host parity:
    // readSwarmConfig only bails on an explicit false).
    const swarmEnabled = observableValue<boolean>(
      'swarmView.enabled',
      configuration.get<boolean>(SWARM_ENABLED_KEY) !== false,
    )
    this._register(
      configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SWARM_ENABLED_KEY)) {
          swarmEnabled.set(configuration.get<boolean>(SWARM_ENABLED_KEY) !== false, undefined)
        }
      }),
    )

    // Register the container only while a perforce source control exists (the
    // extension activated for this workspace) AND `perforce.swarm.enabled` is on.
    // Swarm reviews are meaningless outside a Perforce workspace, and the whole
    // integration is off when the switch is off, so either way the whole entry
    // point disappears from the Activity Bar instead of rendering an unusable
    // view. Deregistering (rather than gating the views with a `when` clause) is
    // deliberate: LayoutService._findViewDescriptor reads ViewRegistry directly
    // and ignores `when`, so focusView would still activate a container that is
    // no longer in the Activity Bar — leaving the SideBar on a blank container.
    // The holder is registered on this contribution so the leak tracker roots the
    // dynamic registrations through it (a plain closure variable would be reported).
    const registrations = this._register(new MutableDisposable())
    this._register(
      autorun((r) => {
        const hasPerforce = scmService.sourceControls.read(r).some((sc) => sc.id === 'perforce')
        const enabled = swarmEnabled.read(r)
        if (hasPerforce && enabled && !registrations.value) {
          // A freshly (re)registered container has no count computed against it
          // yet, and the view that owns it only mounts after this runs. Clearing
          // here too (not just on the way out) closes the window a deregistration
          // race leaves open: the unmounting view's effect can still write the
          // count it was showing after the branch below zeroed it.
          swarmNeedsActionCount.set(0)
          registrations.value = combinedDisposable(
            ViewContainerRegistry.registerViewContainer({
              id: SWARM_CONTAINER_ID,
              label: localize('viewContainer.swarm', 'Swarm Reviews'),
              icon: 'git-pull-request',
              // Directly after SCM (order 3), before Session Changes (order 4).
              order: 3.5,
              location: ViewContainerLocation.SideBar,
            }),
            registerViewWithComponent(
              {
                id: SWARM_REVIEWS_VIEW_ID,
                name: localize('view.swarm.reviews', 'Reviews'),
                containerId: SWARM_CONTAINER_ID,
                icon: 'git-pull-request',
                order: 1,
              },
              SwarmReviewsView,
            ),
            registerViewWithComponent(
              {
                id: SWARM_CHANGES_VIEW_ID,
                name: localize('view.swarm.changes', 'Swarm Changes'),
                containerId: SWARM_CONTAINER_ID,
                icon: 'diff',
                order: 2,
              },
              SwarmChangesView,
              SwarmChangesViewToolbar,
            ),
          )
        } else if (!hasPerforce || !enabled) {
          registrations.clear()
          // Nothing recomputes this count while Swarm is off: the view is gone,
          // and the background poll — when it is running at all — only ever gets
          // the host's empty fallback (`readSwarmConfig` bails on a disabled
          // switch), so it writes 0 at best. Left alone, the last value would
          // survive and flash on the Activity Bar badge and the host status bar
          // until the view reloads.
          swarmNeedsActionCount.set(0)
        }
      }),
    )
  }
}
