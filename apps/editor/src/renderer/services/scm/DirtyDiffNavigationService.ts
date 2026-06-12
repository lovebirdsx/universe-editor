/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DirtyDiffNavigationService — bridges the dirty-diff regions computed for the
 *  active editor (by DirtyDiffContribution, for gutter decorations) to the
 *  "go to next/previous change" commands. It caches the active editor's regions
 *  and mirrors their count into the `quickDiffDecorationCount` context key, so the
 *  navigation keybindings only fire when the file actually has changes — matching
 *  VSCode's `quickDiffDecorationCount != '0'` when-clause.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, IContextKeyService, type IContextKey } from '@universe-editor/platform'
import type { DirtyDiffRegion } from '../../contributions/dirtyDiff.js'

export interface IDirtyDiffNavigationService {
  readonly _serviceBrand: undefined
  /** Regions for the active editor, sorted ascending by `startLine`. */
  readonly regions: readonly DirtyDiffRegion[]
  setRegions(regions: readonly DirtyDiffRegion[]): void
}

export const IDirtyDiffNavigationService = createDecorator<IDirtyDiffNavigationService>(
  'dirtyDiffNavigationService',
)

export class DirtyDiffNavigationService implements IDirtyDiffNavigationService {
  declare readonly _serviceBrand: undefined

  private _regions: readonly DirtyDiffRegion[] = []
  private readonly _count: IContextKey<number>

  constructor(@IContextKeyService contextKeyService: IContextKeyService) {
    this._count = contextKeyService.createKey<number>('quickDiffDecorationCount', 0)
  }

  get regions(): readonly DirtyDiffRegion[] {
    return this._regions
  }

  setRegions(regions: readonly DirtyDiffRegion[]): void {
    this._regions = regions
    this._count.set(regions.length)
  }
}

/**
 * The region to jump to from `line`, wrapping at the ends like VSCode.
 *   - 'next': first region starting below `line`, else the first region.
 *   - 'previous': last region starting above `line`, else the last region.
 * Returns undefined when there are no regions.
 */
export function findAdjacentChange(
  regions: readonly DirtyDiffRegion[],
  line: number,
  direction: 'next' | 'previous',
): DirtyDiffRegion | undefined {
  if (regions.length === 0) return undefined
  if (direction === 'next') {
    return regions.find((r) => r.startLine > line) ?? regions[0]
  }
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]
    if (r && r.startLine < line) return r
  }
  return regions[regions.length - 1]
}
