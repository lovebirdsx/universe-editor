/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Swarm Reviews view + review detail
 *  editors. Survives component unmount (only the active view/editor renders) so
 *  returning to the view rehydrates instantly instead of re-fetching. Mirrors
 *  perforceGraphViewState (module-level singleton, matching the renderer registries).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, observableValue, type Event, type IObservable } from '@universe-editor/platform'
import type {
  SwarmDashboardResult,
  SwarmReviewDetailDto,
  SwarmReviewFilter,
  SwarmTransitionDto,
} from '@universe-editor/extensions-common'

export type SwarmReviewFilesViewMode = 'list' | 'tree'

export interface SwarmReviewsViewState {
  /** Last loaded dashboard grouping, or null if never loaded. */
  dashboard: SwarmDashboardResult | null
  /** Per-review legal transitions, keyed by review id. Persisted so reopening the
   *  view keeps the approvable filter accurate immediately (no flash of the full
   *  list while verdicts reload). */
  transitions: Record<string, SwarmTransitionDto[]>
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
  transitions: {},
  filter: {},
  keyword: '',
  scrollTop: 0,
  focusFilter: null,
}

/** Per-review detail cache, keyed by review id, so reopening a review tab is instant. */
export const swarmReviewDetailCache = new Map<string, SwarmReviewDetailDto>()

/**
 * Cross-component bus tying the review detail editor to the Swarm Reviews view.
 * Module-level singleton Emitters (never disposed — see memory
 * `strictmode-useref-emitter-dispose-dev-only`): they outlive any single mounted
 * component, so the list can react to an action taken in a detail tab.
 */
const _onDidMutateReview = new Emitter<string>()
const _onDidRequestRefresh = new Emitter<void>()

export const swarmReviewEvents = {
  /** Fired after a review's state changed in a detail tab (vote / transition /
   *  update / obliterate). Carries the review id. */
  onDidMutateReview: _onDidMutateReview.event as Event<string>,
  /** Fired by the title-bar manual-refresh command. */
  onDidRequestRefresh: _onDidRequestRefresh.event as Event<void>,
}

/** Signal that a review mutated so the list can re-fetch its dashboard. */
export function notifyReviewMutated(reviewId: string): void {
  _onDidMutateReview.fire(reviewId)
}

/** Signal a manual refresh request (from the view title bar). */
export function requestSwarmReviewsRefresh(): void {
  _onDidRequestRefresh.fire()
}

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
