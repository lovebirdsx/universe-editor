/**
 * Pure helpers for the "Update a Swarm Review…" flow: turn the reviews a user
 * authored into a ranked QuickPick list so they can attach a fresh version of a
 * changelist to one of their existing reviews (P4V's "Update a Swarm Review…").
 *
 * Ranking mirrors what the author most likely wants to update:
 *   1. needsRevision  — the review was bounced back and is waiting on the author
 *   2. needsReview    — still open, a re-shelve is a normal iteration
 *   3. everything else that is still open (defensive; states are server-defined)
 * Terminal reviews (approved / rejected / archived) are dropped — you don't push
 * new versions to a closed review. Within a rank, newest-updated first.
 *
 * No p4 / REST I/O here — the command layer fetches the reviews and feeds them in,
 * so this stays unit-testable against fixtures.
 */
import type { SwarmReview } from './swarmParser.js'

/** A QuickPick entry for one candidate review. `reviewId` is the payload the
 *  command handler reads back off the picked item (extra fields survive the
 *  showQuickPick round-trip). */
export interface ReviewPickItem {
  label: string
  description: string
  detail: string
  reviewId: string
}

const RANK: Record<string, number> = {
  needsRevision: 0,
  needsReview: 1,
}

/** True for reviews you can still push a new version to. */
function isOpen(state: string): boolean {
  return state === 'needsReview' || state === 'needsRevision'
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  return line
}

/**
 * Rank + format the authored reviews into QuickPick items. Closed reviews are
 * dropped. `label` shows the review id + state, `description` the first line of
 * the review description, `detail` a compact vote/comment summary.
 */
export function buildReviewPicks(reviews: readonly SwarmReview[]): ReviewPickItem[] {
  return reviews
    .filter((r) => isOpen(r.state))
    .slice()
    .sort((a, b) => {
      const ra = RANK[a.state] ?? 2
      const rb = RANK[b.state] ?? 2
      if (ra !== rb) return ra - rb
      return b.updated - a.updated
    })
    .map((r) => ({
      label: `#${r.id} · ${r.stateLabel}`,
      description: firstLine(r.description),
      detail: `↑${r.upVotes} ↓${r.downVotes} · ${r.commentCount} comments`,
      reviewId: r.id,
    }))
}
