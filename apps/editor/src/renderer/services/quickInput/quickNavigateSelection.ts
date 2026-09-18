/*---------------------------------------------------------------------------------------------
 *  Shared quick-pick placement for quick-navigate pickers (Ctrl+Tab editor/view
 *  switching, Alt+S session switching).
 *--------------------------------------------------------------------------------------------*/

import type { IQuickPickItem } from '@universe-editor/platform'

/**
 * Index to highlight when the picker opens: one step away from wherever the
 * user currently is, so a single Ctrl+Tab (or Alt+S) lands on the previous
 * target. Falls back to the classic "index 0 is here" assumption when the
 * current location isn't in the list (focus parked on the activity bar / status
 * bar, say).
 *
 * The result is used verbatim as the panel's focused index, so `items` must be
 * the exact array handed to `pick`. A separator inside it counts as an ordinary
 * row here (no caller passes one yet); the panel would snap the highlight off
 * it, landing one row further than asked.
 */
export function computeInitialSelectionIndex(
  items: readonly IQuickPickItem[],
  currentId: string | undefined,
  reverse: boolean,
): number {
  if (items.length === 0) return 0
  const currentIdx = currentId === undefined ? -1 : items.findIndex((i) => i.id === currentId)
  const from = currentIdx === -1 ? 0 : currentIdx
  const step = reverse ? -1 : 1
  return (((from + step) % items.length) + items.length) % items.length
}
