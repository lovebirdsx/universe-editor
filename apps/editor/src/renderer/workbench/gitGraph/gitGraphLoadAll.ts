/**
 * Constants and pure helpers for the Git Graph "Load all commits" flow.
 * Kept outside the editor component so the thresholds, the streamed-prefix
 * bookkeeping and the shallow-refresh merge are unit-testable without rendering
 * the graph.
 */
import type { GitGraphCommitDto } from '@universe-editor/extensions-common'

/** Above this many commits, Load all asks for confirmation first. */
export const LOAD_ALL_CONFIRM_THRESHOLD = 20_000
/** Hard safety cap: the renderer never streams more than this in one go. */
export const LOAD_ALL_MAX_COMMITS = 50_000
/** Coalesce stream batches into at most one React update per interval. */
export const STREAM_FLUSH_INTERVAL = 120

/**
 * Layout is recomputed from the whole list on every publication, so a large
 * stream must publish less often; publishing every 1000 commits would otherwise
 * spend quadratic CPU re-laying out history the user cannot see yet.
 */
export function streamFlushInterval(commitCount: number): number {
  if (commitCount >= 20_000) return 800
  if (commitCount >= 5_000) return 400
  return STREAM_FLUSH_INTERVAL
}

/** Above this many rows the editor windows rows and SVG nodes by viewport. */
export const VIRTUALIZATION_THRESHOLD = 200
/** Height of the sticky header, mirrors `--graph-header-height` in the CSS. */
export const GRAPH_HEADER_HEIGHT = 24

/**
 * Book-keeping for a running stream.
 *
 * `streamed` accumulates the batches the extension produced (newest first).
 * `tail` is the pre-stream list minus everything the stream has already
 * produced; keeping it means the visible list does not shrink (and the scroll
 * position does not clamp) while the stream is still catching up. `tail` is
 * `null` until the first batch arrives, at which point it is derived from the
 * list that was on screen.
 *
 * The stream is the authority on commit identity: a pre-stream commit is only
 * kept while the stream has not emitted its hash, and `finishStreamedState`
 * drops the tail entirely once the stream ends so a concurrently rewritten
 * history cannot leave stale rows behind.
 */
export interface StreamedCommitState {
  readonly streamed: readonly GitGraphCommitDto[]
  readonly tail: readonly GitGraphCommitDto[] | null
}

export function createStreamedCommitState(): StreamedCommitState {
  return { streamed: [], tail: null }
}

export function appendStreamedBatch(
  state: StreamedCommitState,
  base: readonly GitGraphCommitDto[],
  incoming: readonly GitGraphCommitDto[],
): StreamedCommitState {
  if (incoming.length === 0) return state
  const seen = new Set(incoming.map((c) => c.hash))
  const source = state.tail ?? base
  return {
    streamed: [...state.streamed, ...incoming],
    tail: source.filter((c) => !seen.has(c.hash)),
  }
}

/** The list to render while the stream is still running. */
export function materializeStreamedCommits(state: StreamedCommitState): GitGraphCommitDto[] {
  return state.tail === null ? [...state.streamed] : [...state.streamed, ...state.tail]
}

/** Drop the not-yet-reached pre-stream tail: the streamed list is complete. */
export function finishStreamedState(state: StreamedCommitState): StreamedCommitState {
  return { streamed: state.streamed, tail: [] }
}

/** Insert after every commit with the same or a newer date (mirrors the extension). */
export function insertByDateDesc(commits: GitGraphCommitDto[], node: GitGraphCommitDto): void {
  let i = 0
  while (i < commits.length && commits[i]!.date >= node.date) i++
  commits.splice(i, 0, node)
}

/**
 * Merge a freshly fetched first page into a fully/partially loaded list.
 *
 * `fresh` always carries the complete current stash list (the extension merges
 * every stash into every page, even ones older than the page), so stash nodes
 * are stripped from both sides and re-inserted by date into the merged list.
 * That drops stashes deleted since the previous load and keeps their ordering
 * correct even when they sort after the first page.
 */
export function mergeShallowRefresh(
  oldCommits: readonly GitGraphCommitDto[],
  fresh: readonly GitGraphCommitDto[],
): GitGraphCommitDto[] {
  const freshLog = fresh.filter((c) => c.stash === null)
  const stashes = fresh.filter((c) => c.stash !== null)
  const freshHashes = new Set(freshLog.map((c) => c.hash))
  const oldTail = oldCommits.filter((c) => c.stash === null && !freshHashes.has(c.hash))
  const merged = [...freshLog, ...oldTail]
  for (const stash of [...stashes].sort((a, b) => b.date - a.date)) {
    insertByDateDesc(merged, stash)
  }
  return merged
}
