/**
 * Chat-context providers for the agent input's `#` popover
 * (`chat.registerChatContextProvider`).
 *
 * The `#` list shows ONE entry per provider; the provider then runs its own
 * QuickPick and returns the accepted item, so the candidate space (changelists,
 * reviews) never leaves the extension. Registration happens inside `activate`
 * after client discovery, which is exactly the gate "only when this is a
 * Perforce workspace".
 *
 * The injected text is what the agent reads, so it carries the identifying
 * information — and it mirrors the renderer's own entries (the Perforce Graph /
 * SCM / Swarm context menus, `services/acp/chatContextFormat.ts`). The
 * renderer is not importable from here, so the templates exist twice; each side
 * has a test pinning its shape.
 */
import { chat, window, type Disposable, type QuickPickItem } from '@universe-editor/extension-api'
import type { ChatContextItem } from '@universe-editor/extension-api'
import type { ClientManager } from './clientManager.js'
import type { PerforceClient } from './client.js'
import type { SwarmReview } from './swarm/swarmParser.js'
import { descriptionFirstLine } from './changelist.js'
import { buildScopeFilespec } from './p4Filespec.js'
import { localize } from './nls.js'

/** How many recently submitted changes the changelist pick offers below the
 *  pending ones (the graph lists 300; a chat reference is a targeted pick). */
const RECENT_SUBMITTED_PICKS = 30

/** How many reviews the Swarm pick offers (one Swarm page, newest-updated first). */
export const SWARM_CHAT_PICKS = 50

/** A pick row plus the item the accepted row hands back to the renderer. Extra
 *  fields survive the `showQuickPick` round-trip, which is how the payload gets
 *  out of the picker. */
export interface ChatPickItem extends QuickPickItem {
  readonly item: ChatContextItem
}

/** `Perforce changelist 1234: fix the parser` — id + description first line.
 *  KEEP IN SYNC with the renderer's `formatChangelistText`. */
export function changelistChatText(id: string, description: string): string {
  const summary = descriptionFirstLine(description)
  return summary ? `Perforce changelist ${id}: ${summary}` : `Perforce changelist ${id}`
}

/** `Swarm review 1001 "fix the parser": Needs Review — <review url>`.
 *  KEEP IN SYNC with the renderer's `formatSwarmReviewText`. */
export function swarmReviewChatText(review: {
  readonly id: string
  readonly description: string
  readonly stateLabel: string
  readonly url: string | undefined
}): string {
  const summary = descriptionFirstLine(review.description)
  const head = summary ? `Swarm review ${review.id} "${summary}"` : `Swarm review ${review.id}`
  const detail = [review.stateLabel.trim(), review.url ?? ''].filter((part) => part !== '')
  return detail.length > 0 ? `${head}: ${detail.join(' — ')}` : head
}

/** `https://swarm.example.com/reviews/1001` — same shape the renderer builds. */
export function swarmReviewUrl(baseUrl: string, reviewId: string): string | undefined {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return base ? `${base}/reviews/${encodeURIComponent(reviewId)}` : undefined
}

function changelistPick(id: string, description: string, state: string): ChatPickItem {
  return {
    label: `#${id} · ${state}`,
    description: descriptionFirstLine(description),
    item: { label: `Perforce changelist ${id}`, text: changelistChatText(id, description) },
  }
}

/**
 * Pending changelists first (they are what the user is working on), then the
 * newest submitted ones. Pure — the caller supplies both lists.
 */
export function buildChangelistChatPicks(
  pending: readonly { readonly id: string; readonly description: string }[],
  submitted: readonly { readonly id: string; readonly message: string }[],
): ChatPickItem[] {
  const pendingState = localize('perforce.chat.state.pending', 'Pending')
  const submittedState = localize('perforce.chat.state.submitted', 'Submitted')
  const seen = new Set(pending.map((p) => p.id))
  return [
    ...pending.map((p) => changelistPick(p.id, p.description, pendingState)),
    ...submitted
      .filter((c) => !seen.has(c.id))
      .map((c) => changelistPick(c.id, c.message, submittedState)),
  ]
}

/** One row per review, as Swarm returned them (newest-updated first). */
export function buildSwarmChatPicks(
  reviews: readonly SwarmReview[],
  baseUrl: string,
): ChatPickItem[] {
  return reviews.map((review) => {
    const url = swarmReviewUrl(baseUrl, review.id)
    return {
      label: `#${review.id} · ${review.stateLabel}`,
      description: descriptionFirstLine(review.description),
      item: {
        label: `Swarm review ${review.id}`,
        text: swarmReviewChatText({
          id: review.id,
          description: review.description,
          stateLabel: review.stateLabel,
          url,
        }),
      },
    }
  })
}

/** Run the provider's picker over `picks`; undefined when empty or cancelled. */
async function pickItem(
  picks: readonly ChatPickItem[],
  emptyMessage: string,
  placeHolder: string,
): Promise<ChatContextItem | undefined> {
  if (picks.length === 0) {
    await window.showInformationMessage(emptyMessage)
    return undefined
  }
  const picked = await window.showQuickPick([...picks], { placeHolder })
  return picked?.item
}

/**
 * Changelist provider: pending changelists (from the last refresh, no p4 call)
 * followed by the newest submitted changes in the client's view. The default
 * changelist is left out — it has no number and no description of its own.
 */
export function registerChangelistChatProvider(mgr: ClientManager): Disposable {
  return chat.registerChatContextProvider({
    label: localize('perforce.chat.changelist.label', 'Perforce Changelist…'),
    description: localize(
      'perforce.chat.changelist.description',
      'Add a pending or recently submitted changelist to the chat',
    ),
    iconId: 'changelist',
    keywords: [
      'changelist',
      'change',
      'cl',
      'p4',
      'perforce',
      'pending',
      'submitted',
      '变更',
      '提交',
    ],
    async resolve() {
      const target = mgr.active
      if (!target) return undefined
      const [pending, submitted] = await Promise.all([
        readPendingPicks(target),
        readSubmittedPicks(target),
      ])
      return pickItem(
        buildChangelistChatPicks(pending, submitted),
        localize('perforce.chat.changelist.empty', 'No changelist to add.'),
        localize('perforce.chat.changelist.placeholder', 'Select a changelist'),
      )
    },
  })
}

/**
 * Swarm provider. `fetchReviews` (owned by the swarm module, which holds the
 * config / credential / cache) returns `undefined` when Swarm is off or
 * unconfigured — that is a notice, not an empty list.
 */
export function registerSwarmChatProvider(
  fetchReviews: () => Promise<
    { readonly reviews: readonly SwarmReview[]; readonly url: string } | undefined
  >,
): Disposable {
  return chat.registerChatContextProvider({
    label: localize('perforce.chat.swarm.label', 'Swarm Review…'),
    description: localize(
      'perforce.chat.swarm.description',
      'Add a Helix Swarm code review to the chat',
    ),
    iconId: 'git-pull-request',
    keywords: ['swarm', 'review', 'reviews', '审核', '评审', '代码评审'],
    async resolve() {
      const fetched = await fetchReviews()
      if (!fetched) {
        await window.showInformationMessage(
          localize(
            'perforce.swarm.notConfigured',
            'Swarm is not configured. Set perforce.swarm.enabled and perforce.swarm.url.',
          ),
        )
        return undefined
      }
      return pickItem(
        buildSwarmChatPicks(fetched.reviews, fetched.url),
        localize('perforce.chat.swarm.empty', 'No Swarm review to add.'),
        localize('perforce.chat.swarm.placeholder', 'Select a Swarm review'),
      )
    },
  })
}

/** Pending numbered changelists, from the client's cached refresh. */
async function readPendingPicks(
  target: PerforceClient,
): Promise<readonly { readonly id: string; readonly description: string }[]> {
  const picks = await target.changelistPicks()
  return picks
    .filter((p) => p.id !== 'default' && p.id !== 'new')
    .map((p) => ({ id: p.id, description: p.description ?? '' }))
}

/** Newest submitted changes in this client's view (one cached `p4 changes`). */
async function readSubmittedPicks(
  target: PerforceClient,
): Promise<readonly { readonly id: string; readonly message: string }[]> {
  const listing = await target.getGraphChanges(RECENT_SUBMITTED_PICKS, [
    buildScopeFilespec(target.root, true),
  ])
  return listing?.changes.slice(0, RECENT_SUBMITTED_PICKS) ?? []
}
