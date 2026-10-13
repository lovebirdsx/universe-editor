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
import { isUnderAny } from './pathUtil.js'
import { localize } from './nls.js'

/** How many changelists the pick offers in total — the pending ones first (they
 *  are what the user is working on), then the newest submitted ones. Also the
 *  `p4 changes` cap, so one round trip can fill the whole list (the graph lists
 *  300; a chat reference is a targeted pick). */
const MAX_CHANGELIST_PICKS = 100

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
 * newest submitted ones, capped at {@link MAX_CHANGELIST_PICKS} overall — the
 * pending rows are the ones kept when the two together overflow. Pure — the
 * caller supplies both lists.
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
  ].slice(0, MAX_CHANGELIST_PICKS)
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

/**
 * Needs-my-action reviews first, then the ones I authored, deduped by id (a
 * review can be both — Swarm lists it under whichever group the caller asked
 * for first). Both inputs keep their own order; the caller's dashboard sort
 * already puts the most relevant on top.
 */
export function mergeSwarmPicks(
  needsAction: readonly SwarmReview[],
  authored: readonly SwarmReview[],
): readonly SwarmReview[] {
  const seen = new Set(needsAction.map((r) => r.id))
  return [...needsAction, ...authored.filter((r) => !seen.has(r.id))]
}

/**
 * Run the provider's picker over `picks`; undefined when the list came back
 * empty or the user cancelled.
 *
 * `load` is handed over *unawaited* so the picker opens (with a progress bar)
 * while the p4 / Swarm round-trips are still in flight — a silent pause before
 * the list appears reads as a hang. The accepted row is the item itself, so the
 * resolved list is captured through the same promise for the empty case, where
 * the (already dismissed) picker cannot tell us anything. `settled` narrows
 * that further: a load that had not finished when the picker went away means
 * the user cancelled, and "nothing to add" would be a message about a list they
 * never saw.
 */
async function pickItem(
  load: () => Promise<ChatPickItem[]>,
  emptyMessage: string,
  placeHolder: string,
): Promise<ChatContextItem | undefined> {
  let loaded: readonly ChatPickItem[] = []
  let settled = false
  const pending = load().then((picks) => {
    loaded = picks
    settled = true
    return picks
  })
  const picked = await window.showQuickPick(pending, { placeHolder })
  if (picked) return picked.item
  if (settled && loaded.length === 0) await window.showInformationMessage(emptyMessage)
  return undefined
}

/**
 * The directory the candidates are scoped to: the session's own directory when
 * it sits inside a Perforce client (the agent runs there, so that is what the
 * user is looking at), otherwise the whole client root.
 */
function scopeDirFor(target: PerforceClient, sessionDir: string | undefined): string {
  if (sessionDir && isUnderAny(sessionDir, [target.root])) return sessionDir
  return target.root
}

/**
 * Changelist provider: pending changelists (from the last refresh, no p4 call)
 * followed by the newest submitted changes — both scoped to the session's
 * directory. The default changelist is left out — it has no number and no
 * description of its own.
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
    async resolve(_query, context) {
      // Everything cache-only resolves before `showQuickPick`: a lazy picker
      // that opens and immediately closes looks like a glitch.
      const target =
        (context.sessionDir ? mgr.resolveContaining(context.sessionDir) : undefined) ?? mgr.active
      if (!target) return undefined
      const scopeDir = scopeDirFor(target, context.sessionDir)
      return pickItem(
        async () =>
          buildChangelistChatPicks(
            readPendingPicks(target, scopeDir),
            await readSubmittedPicks(target, scopeDir),
          ),
        localize('perforce.chat.changelist.empty', 'No changelist to add.'),
        localize('perforce.chat.changelist.placeholder', 'Select a changelist'),
      )
    },
  })
}

/**
 * What the swarm module hands the provider. Two stages on purpose: the config
 * check behind {@link fetchSource} is cheap (a few configuration reads) and
 * decides whether a picker should open at all, while `loadReviews` is the
 * network round trip and runs *inside* the picker's loader so the progress bar
 * covers it.
 */
export interface SwarmChatSource {
  readonly url: string
  readonly loadReviews: () => Promise<{
    readonly needsAction: readonly SwarmReview[]
    readonly authored: readonly SwarmReview[]
  }>
}

/**
 * Swarm provider. `fetchSource` (owned by the swarm module, which holds the
 * config / credential / cache) returns `undefined` when Swarm is off or
 * unconfigured — that is a notice, not an empty list, so it is answered
 * *before* the picker opens rather than by closing one.
 */
export function registerSwarmChatProvider(
  fetchSource: () => Promise<SwarmChatSource | undefined>,
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
      const source = await fetchSource()
      if (!source) {
        await window.showInformationMessage(
          localize(
            'perforce.swarm.notConfigured',
            'Swarm is not configured. Set perforce.swarm.enabled and perforce.swarm.url.',
          ),
        )
        return undefined
      }
      return pickItem(
        async () => {
          const { needsAction, authored } = await source.loadReviews()
          return buildSwarmChatPicks(mergeSwarmPicks(needsAction, authored), source.url)
        },
        localize('perforce.chat.swarm.empty', 'No Swarm review to add.'),
        localize('perforce.chat.swarm.placeholder', 'Select a Swarm review'),
      )
    },
  })
}

/**
 * Pending numbered changelists with an opened file under `scopeDir`, from the
 * client's cached refresh (no p4 call). Shelved-only changelists drop out: the
 * cache maps opened files, so a changelist whose files are all shelved has
 * nothing pointing at it — narrow the session directory and it disappears.
 */
function readPendingPicks(
  target: PerforceClient,
  scopeDir: string,
): readonly { readonly id: string; readonly description: string }[] {
  return target
    .pendingChangelistsUnder(scopeDir)
    .map((cl) => ({ id: cl.id, description: cl.description ?? '' }))
}

/** Newest submitted changes under `scopeDir` (one cached `p4 changes`). */
async function readSubmittedPicks(
  target: PerforceClient,
  scopeDir: string,
): Promise<readonly { readonly id: string; readonly message: string }[]> {
  const listing = await target.getGraphChanges(MAX_CHANGELIST_PICKS, [
    buildScopeFilespec(scopeDir, true),
  ])
  return listing?.changes.slice(0, MAX_CHANGELIST_PICKS) ?? []
}
