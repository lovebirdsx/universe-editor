/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Swarm Reviews view + review detail
 *  editors. Survives component unmount (only the active view/editor renders) so
 *  returning to the view rehydrates instantly instead of re-fetching. Mirrors
 *  perforceGraphViewState (module-level singleton, matching the renderer registries).
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  observableValue,
  type IDisposable,
  type Event,
  type IObservable,
} from '@universe-editor/platform'
import type {
  SwarmDashboardResult,
  SwarmReviewDetailDto,
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
}

export const swarmReviewsViewState: SwarmReviewsViewState = {
  dashboard: null,
  transitions: {},
}

const _needsActionCount = observableValue<number>('swarm.needsActionCount', 0)

/**
 * The "Needs My Action" count in the sidebar's group scope (author / approvable
 * filters + client-side ignore applied; the transient keyword box excluded — a
 * lookup, not a scope). Unlike notifications it includes open reviews authored
 * by the current user, matching what the group header shows. Written by
 * SwarmReviewsView while mounted and by SwarmReviewNotificationContribution's
 * background poll otherwise; read by SwarmActivityContribution for the badge.
 */
export const swarmNeedsActionCount = {
  observable: _needsActionCount as IObservable<number>,
  set(count: number): void {
    _needsActionCount.set(count, undefined)
  },
}

/** Per-review detail cache, keyed by review id, so reopening a review tab is instant. */
export const swarmReviewDetailCache = new Map<string, SwarmReviewDetailDto>()

/**
 * Per-review editor UI state, keyed by review id. The review detail editor
 * unmounts whenever its tab is deactivated (only the active editor renders),
 * which would otherwise reset the version selectors, the draft comment and the
 * file-list scroll offset on every return. This module-level singleton survives
 * unmount so switching tabs and coming back rehydrates instantly. In-memory
 * only (mirrors swarmReviewDetailCache) — not persisted across restarts.
 */
export interface SwarmReviewEditorState {
  /** Right-hand (selected) version, or null before the detail loads. */
  selectedVersion: number | null
  /** Left-hand (compare) version; null = the depot base. */
  compareVersion: number | null
  /** Unsent review-level comment draft. */
  commentDraft: string
  /** Vertical scroll offset of the changed-file list. */
  filesScrollTop: number
}

const _reviewEditorStates = new Map<string, SwarmReviewEditorState>()

export function getSwarmReviewEditorState(reviewId: string): SwarmReviewEditorState | undefined {
  return _reviewEditorStates.get(reviewId)
}

export function updateSwarmReviewEditorState(
  reviewId: string,
  patch: Partial<SwarmReviewEditorState>,
): void {
  if (!reviewId) return
  const prev = _reviewEditorStates.get(reviewId) ?? {
    selectedVersion: null,
    compareVersion: null,
    commentDraft: '',
    filesScrollTop: 0,
  }
  _reviewEditorStates.set(reviewId, { ...prev, ...patch })
}

/** Test-only: drop all per-review editor UI state (module singleton). */
export function clearSwarmReviewEditorStates(): void {
  _reviewEditorStates.clear()
}

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

/**
 * Manual-refresh acknowledgements: the title-bar Refresh command awaits the
 * returned promise for its disabled/spinning state, so a request only resolves
 * once the view's reload has actually settled. Acks are flushed by the mounted
 * view via {@link resolveSwarmReviewsRefresh}; when no view is consuming (it
 * can't be clicked then, but a programmatic caller might race startup), the
 * request resolves immediately rather than hang.
 */
const _pendingRefreshAcks: Array<() => void> = []
let _refreshConsumers = 0

/** The mounted reviews view registers itself as the refresh consumer for the
 *  lifetime of its subscription. */
export function trackSwarmRefreshConsumer(): IDisposable {
  _refreshConsumers++
  return {
    dispose: () => {
      _refreshConsumers--
      // Don't strand a request fired just before the view unmounted.
      resolveSwarmReviewsRefresh()
    },
  }
}

/** Signal a manual refresh request (from the view title bar). Resolves when the
 *  view's triggered reload has settled. */
export function requestSwarmReviewsRefresh(): Promise<void> {
  if (_refreshConsumers === 0) return Promise.resolve()
  return new Promise((resolve) => {
    _pendingRefreshAcks.push(resolve)
    _onDidRequestRefresh.fire()
  })
}

/** Called by the mounted view once the reload it triggered has settled. */
export function resolveSwarmReviewsRefresh(): void {
  for (const ack of _pendingRefreshAcks.splice(0)) ack()
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
