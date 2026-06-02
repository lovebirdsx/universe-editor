/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FirstRunAgentOnboardingContribution — on a brand-new install, reveals the
 *  Agents side bar once so first-time users discover the editor's core feature.
 *  Gated by a GLOBAL storage flag so it only ever fires on the first launch;
 *  the persistent Agent entry point lives in WelcomeEditor afterwards.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILayoutService,
  IStorageService,
  IViewsService,
  IWorkbenchContribution,
  PartId,
  StorageScope,
} from '@universe-editor/platform'

const AGENTS_CONTAINER_ID = 'workbench.view.agents'
const SEEN_KEY = 'welcome.agentOnboarding.seen'

export class FirstRunAgentOnboardingContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
  ) {
    super()
    void this._maybeReveal()
  }

  private async _maybeReveal(): Promise<void> {
    const seen = await this._storage.get<boolean>(SEEN_KEY, StorageScope.GLOBAL)
    if (seen) return
    await this._storage.set(SEEN_KEY, true, StorageScope.GLOBAL)
    if (!this._layout.getVisible(PartId.SecondarySideBar)) {
      this._layout.toggleVisible(PartId.SecondarySideBar)
    }
    this._views.openViewContainer(AGENTS_CONTAINER_ID)
  }
}
