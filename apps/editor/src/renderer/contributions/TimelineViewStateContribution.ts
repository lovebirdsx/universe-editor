/*---------------------------------------------------------------------------------------------
 *  TimelineViewStateContribution — registers the Timeline view's settings and
 *  persists its Filter-by-Source exclusion set to WORKSPACE storage under the
 *  VSCode key `timeline.excludeSources`. The state itself lives in the
 *  module-level timelineViewState observable shared by the view body and its
 *  title-bar toolbar.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  ConfigurationRegistry,
  Disposable,
  IStorageService,
  IWorkbenchContribution,
  localize,
  StorageScope,
} from '@universe-editor/platform'
import { timelineViewState } from '../workbench/timeline/timelineViewState.js'

const STORAGE_KEY = 'timeline.excludeSources'

export class TimelineViewStateContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'timeline',
        title: localize('settings.timeline', 'Timeline'),
        properties: {
          'timeline.pageSize': {
            type: 'number',
            default: 50,
            description: localize(
              'settings.timeline.pageSize',
              'The number of items to show in the Timeline view per page.',
            ),
          },
        },
      }),
    )

    void this._hydrate()
  }

  private async _hydrate(): Promise<void> {
    const saved = await this._storage.get<unknown>(STORAGE_KEY, StorageScope.WORKSPACE)
    if (Array.isArray(saved)) {
      timelineViewState.setExcludedSources(saved.filter((s): s is string => typeof s === 'string'))
    }

    // Write back on any change; the first autorun pass only observes the
    // just-hydrated value, so skip it to avoid echoing it back to storage.
    let firstPass = true
    this._register(
      autorun((r) => {
        const next = timelineViewState.excludedSources.read(r)
        if (firstPass) {
          firstPass = false
          return
        }
        void this._storage.set(STORAGE_KEY, [...next], StorageScope.WORKSPACE)
      }),
    )
  }
}
