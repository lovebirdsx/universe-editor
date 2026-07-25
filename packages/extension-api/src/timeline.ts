/**
 * Timeline — file-history providers feeding the editor's built-in Timeline
 * view (the Universe equivalent of VSCode's proposed `timeline` API). An
 * extension registers a `TimelineProvider` for one or more URI schemes; the
 * view pulls pages of `TimelineItem`s for the active file and runs an item's
 * `command` on click (typically opening a diff). The view is owned by the
 * editor — extensions only provide data, exactly like VSCode.
 */
import type { CancellationToken, Event, ProviderResult } from './index.js'
import type { Command } from './scm.js'

/** A single entry in a file's timeline (e.g. one commit). */
export interface TimelineItem {
  /** Provider-local id (e.g. a commit hash). Combined with `source` to key the row. */
  readonly id?: string
  readonly label: string
  /** Secondary text rendered after the label (e.g. relative time). */
  readonly description?: string
  readonly tooltip?: string
  /** Epoch milliseconds; rows sort newest-first across all providers. */
  readonly timestamp: number
  /** Codicon id rendered before the label (e.g. `git-commit`). */
  readonly themeIcon?: string
  /** Run when the row is clicked (typically opens a comparison). */
  readonly command?: Command
  /** Surfaced to `timeline/item/context` menu `when` clauses as `timelineItem`. */
  readonly contextValue?: string
}

/** One page of timeline entries. */
export interface Timeline {
  readonly items: TimelineItem[]
  /**
   * Opaque cursor for the next page, echoed back in {@link TimelineOptions.cursor}.
   * Absent (or undefined) means no more pages.
   */
  readonly cursor?: string
}

export interface TimelineOptions {
  /** Cursor from the previous page; absent for the first page. */
  readonly cursor?: string
  /** Page size requested by the view. */
  readonly limit?: number
}

/** Fired by {@link TimelineProvider.onDidChange} when a provider's data changes. */
export interface TimelineChangeEvent {
  /** The single affected resource, or undefined when the change is global. */
  readonly uri?: string
  /** True → the view drops every cached page for this provider and reloads. */
  readonly reset: boolean
}

/**
 * A source of timeline entries for the schemes it was registered with
 * (mirrors VSCode's `TimelineProvider`).
 */
export interface TimelineProvider {
  /** Stable provider id (e.g. `git-history`); shown as the source filter key. */
  readonly id: string
  /** Human-readable source name shown in the view's filter menu. */
  readonly label: string
  /** Fire when the provider's data changes; the view reloads accordingly. */
  readonly onDidChange?: Event<TimelineChangeEvent>
  provideTimeline(
    uri: string,
    options: TimelineOptions,
    token: CancellationToken,
  ): ProviderResult<Timeline>
}
