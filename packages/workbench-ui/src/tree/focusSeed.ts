/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared focus-cursor seeding for tree views.
 *
 *  Every tree seeds a keyboard cursor when it gains DOM focus so the arrow keys
 *  have somewhere to start. That seed must not reveal the row on pointer focus:
 *  the mousedown that focused the tree is already aimed at a row, and scrolling
 *  the seeded row into view before mouseup moves or unmounts the row under the
 *  pointer, so the click never lands. Keyboard/programmatic focus (Tab, focus
 *  commands) does reveal, otherwise the cursor would be off-screen and invisible.
 *--------------------------------------------------------------------------------------------*/

import type { ISetSelectionOptions } from './TreeModel.js'

/** What caused the tree container to receive DOM focus. */
export type ITreeFocusSource = 'pointer' | 'keyboard'

interface ITreeFocusSeedTarget<TId> {
  setSelection(
    ids: readonly TId[],
    focus?: TId | null,
    options?: Pick<ISetSelectionOptions, 'reveal'> | undefined,
  ): void
}

/** Seed a freshly focused tree's keyboard cursor without yanking the viewport
 *  on pointer focus. Views own the target policy (first row, active symbol,
 *  remembered file); this owns the reveal rule. */
export function seedTreeFocusCursor<TId>(
  target: ITreeFocusSeedTarget<TId>,
  id: TId,
  source: ITreeFocusSource,
): void {
  target.setSelection([id], id, { reveal: source !== 'pointer' })
}
