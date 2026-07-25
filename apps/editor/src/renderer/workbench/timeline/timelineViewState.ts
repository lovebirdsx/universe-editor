/*---------------------------------------------------------------------------------------------
 *  Shared view state for the Timeline viewlet. The title toolbar lives in the
 *  view's title bar (a separate React subtree from the body), so the
 *  source-filter exclusion set is held here as a module-level observable —
 *  mirroring outlineViewState. Hydrated / written back to WORKSPACE storage
 *  (`timeline.excludeSources`, the VSCode key) by TimelineViewStateContribution.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'

const _excludedSources = observableValue<readonly string[]>('timeline.excludedSources', [])

export const timelineViewState = {
  /** Provider ids the user filtered out of the view. */
  excludedSources: _excludedSources as IObservable<readonly string[]>,
  setExcludedSources(ids: readonly string[]): void {
    _excludedSources.set([...ids], undefined)
  },
  toggleSource(id: string): void {
    const cur = _excludedSources.get()
    _excludedSources.set(cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id], undefined)
  },
}
