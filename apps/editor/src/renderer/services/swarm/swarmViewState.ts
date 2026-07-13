/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Swarm Reviews view + review detail
 *  editors. Survives component unmount (only the active view/editor renders) so
 *  returning to the view rehydrates instantly instead of re-fetching. Mirrors
 *  perforceGraphViewState (module-level singleton, matching the renderer registries).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type {
  SwarmDashboardResult,
  SwarmReviewDetailDto,
  SwarmReviewFilter,
} from '@universe-editor/extensions-common'

export type SwarmReviewFilesViewMode = 'list' | 'tree'

export interface SwarmReviewsViewState {
  /** Last loaded dashboard grouping, or null if never loaded. */
  dashboard: SwarmDashboardResult | null
  /** Active list filter (state / author / keyword). */
  filter: SwarmReviewFilter
  /** Free-text keyword typed into the filter bar. */
  keyword: string
  /** Vertical scroll offset, restored on remount. */
  scrollTop: number
  /** Callback registered by the mounted view to focus its filter input. */
  focusFilter: (() => void) | null
}

export const swarmReviewsViewState: SwarmReviewsViewState = {
  dashboard: null,
  filter: {},
  keyword: '',
  scrollTop: 0,
  focusFilter: null,
}

/** Per-review detail cache, keyed by review id, so reopening a review tab is instant. */
export const swarmReviewDetailCache = new Map<string, SwarmReviewDetailDto>()

const _reviewFilesViewMode = observableValue<SwarmReviewFilesViewMode>(
  'swarm.reviewFiles.viewMode',
  'list',
)

export const swarmReviewFilesViewState = {
  viewMode: _reviewFilesViewMode as IObservable<SwarmReviewFilesViewMode>,
  setViewMode(mode: SwarmReviewFilesViewMode): void {
    _reviewFilesViewMode.set(mode, undefined)
  },
}
