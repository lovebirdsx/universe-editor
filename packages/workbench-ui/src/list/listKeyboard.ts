/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  listKeyboard — index navigation shared by Tree and useFlatListNavigation.
 *
 *  Only the keys whose meaning is pure index arithmetic live here: Home / End /
 *  PageUp / PageDown, plus ArrowUp / ArrowDown for flat lists. A tree's arrow
 *  keys are deliberately NOT routed through this — there Right means "expand,
 *  then descend" and Left means "collapse, then ascend", which is structure,
 *  not arithmetic. Tree keeps calling TreeModel.navigate() for those.
 *--------------------------------------------------------------------------------------------*/

export const LIST_PAGE_STEP = 10

export interface IIndexNavigationContext {
  /** Currently focused index; -1 when nothing is focused. */
  readonly index: number
  readonly count: number
  /** Rows per PageUp/PageDown step; defaults to LIST_PAGE_STEP. */
  readonly pageSize?: number | undefined
}

/**
 * Resolve a navigation key to the index it should move to, or undefined when
 * the key is not a navigation key (the caller must then let it through —
 * Tree hands it to onRowKeyDown, the flat hook does the same).
 */
export function resolveIndexNavigation(
  key: string,
  ctx: IIndexNavigationContext,
): number | undefined {
  const { index, count } = ctx
  if (count <= 0) return undefined
  const page = Math.max(1, ctx.pageSize ?? LIST_PAGE_STEP)
  // An unfocused list starts navigating from the top rather than from -1, so
  // the first ArrowDown lands on row 0 instead of skipping it.
  const from = index < 0 ? 0 : index
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i))

  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : clamp(from + 1)
    case 'ArrowUp':
      return index < 0 ? 0 : clamp(from - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'PageDown':
      return clamp(from + page)
    case 'PageUp':
      return clamp(from - page)
    default:
      return undefined
  }
}
