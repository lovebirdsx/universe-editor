/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared query state for the Extensions viewlet. The title toolbar lives in a
 *  separate React subtree (the view's header) from the body, so the search text
 *  is held here as a module-level observable rather than in component state —
 *  mirroring outlineViewState. ExtensionsView resets it on unmount, keeping the
 *  old "the query clears when the view is rebuilt" behaviour.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'

const _query = observableValue<string>('extensionsView.query', '')

export const extensionsViewState = {
  query: _query as IObservable<string>,
  setQuery(value: string): void {
    if (_query.get() === value) return
    _query.set(value, undefined)
  },
  reset(): void {
    if (_query.get() === '') return
    _query.set('', undefined)
  },
}
