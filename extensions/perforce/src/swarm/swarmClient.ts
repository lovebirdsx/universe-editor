/**
 * Swarm client orchestration. Owns one {@link SwarmApi} bound to the active p4
 * connection, resolves credentials lazily via {@link resolveSwarmCredential}, and
 * exposes every review operation the command layer needs. Pulls port/user/ticket
 * from the active PerforceClient's p4 service (Swarm reviews are a server-level
 * resource, so one SwarmClient per p4 server is enough — see design §3.1).
 *
 * This layer stays business-focused: HTTP lives in swarmApi, JSON→model in
 * swarmParser. No credential ever leaves this process except in the Authorization
 * header swarmApi injects.
 */
import type { P4Service } from '../p4Service.js'
import { P4Cache, type P4Clock } from '../p4Cache.js'
import { SwarmApi } from './swarmApi.js'
import type { SwarmLogger } from './swarmLog.js'
import { resolveSwarmCredential } from './swarmAuth.js'
import {
  parseComments,
  parseCreatedReviewId,
  parseReviewDetail,
  parseReviewList,
  parseTransitions,
  type SwarmComment,
  type SwarmReview,
  type SwarmReviewDetail,
  type SwarmTransition,
} from './swarmParser.js'

export interface SwarmClientConfig {
  readonly baseUrl: string
  readonly apiVersion: string
  /** The p4 user (for Basic auth). */
  readonly user: string | undefined
}

export interface SwarmReviewFilter {
  author?: string[]
  participants?: string[]
  state?: string[]
  keywords?: string
  max?: number
  after?: string
}

export interface SwarmDashboard {
  needsAction: SwarmReview[]
  authored: SwarmReview[]
  participating: SwarmReview[]
}

export interface SwarmCacheOptions {
  readonly enabled?: boolean
  readonly ttlMs?: number
  readonly now?: P4Clock
}

const DEFAULT_SWARM_CACHE_TTL_MS = 60_000

const SwarmCacheNs = {
  reviewList: 'swarm.reviewList',
  reviewDetail: 'swarm.reviewDetail',
  transitions: 'swarm.transitions',
  comments: 'swarm.comments',
} as const

const DAY_MS = 86_400_000

export class SwarmClient {
  private readonly _api: SwarmApi
  private readonly _cache: P4Cache
  private readonly _now: P4Clock
  private _dashboardInFlight: Promise<SwarmDashboard> | undefined
  private _dashboardInFlightIsForce = false
  private _dashboardInFlightKey = ''
  private _dashboardQueuedForce: Promise<SwarmDashboard> | undefined

  constructor(
    private readonly _p4: P4Service,
    private readonly _config: SwarmClientConfig,
    private readonly _logger?: SwarmLogger,
    cacheOptions: SwarmCacheOptions = {},
  ) {
    this._api = new SwarmApi({
      baseUrl: _config.baseUrl,
      apiVersion: _config.apiVersion,
      getAuth: () => this._auth(),
      ...(_logger ? { logger: _logger } : {}),
    })
    this._now = cacheOptions.now ?? Date.now
    this._cache = new P4Cache(this._now, undefined, cacheOptions.enabled ?? true)
    const ttlMs = cacheOptions.ttlMs ?? DEFAULT_SWARM_CACHE_TTL_MS
    for (const namespace of Object.values(SwarmCacheNs)) {
      this._cache.register(namespace, { kind: 'ttl', ttlMs })
    }
  }

  /** The p4 user this client authenticates as. */
  get user(): string | undefined {
    return this._config.user
  }

  private async _auth(): Promise<string | undefined> {
    const cred = await resolveSwarmCredential(this._p4, this._config.user)
    if (!cred) {
      this._logger?.warn(
        'auth',
        `no Swarm credential for user '${this._config.user ?? '(unknown)'}' — ` +
          'not logged in or no cached p4 ticket',
      )
    }
    return cred?.basic
  }

  /** Connectivity self-check: fetch one review to confirm URL + auth work. */
  async ping(): Promise<{ ok: boolean; count: number }> {
    const raw = await this._api.get('reviews', { query: { max: 1 } })
    const { reviews } = parseReviewList(raw)
    return { ok: true, count: reviews.length }
  }

  /** List reviews with a filter (one page). */
  async listReviews(
    filter: SwarmReviewFilter = {},
  ): Promise<{ reviews: SwarmReview[]; lastSeen: string | null }> {
    const query: Record<string, string | number | string[] | undefined> = {
      max: filter.max ?? 50,
    }
    if (filter.author) query['author'] = filter.author
    if (filter.participants) query['participants'] = filter.participants
    if (filter.state) query['state'] = filter.state
    if (filter.keywords) query['keywords'] = filter.keywords
    if (filter.after) query['after'] = filter.after
    const key = reviewFilterKey(filter)
    const cached = await this._cache.wrap(SwarmCacheNs.reviewList, key, async () => {
      const raw = await this._api.get('reviews', { query })
      return JSON.stringify(parseReviewList(raw))
    })
    return JSON.parse(cached as string) as { reviews: SwarmReview[]; lastSeen: string | null }
  }

  /** The action-dashboard grouping: needs-my-action / authored / participating.
   *  Concurrent callers (the sidebar view + the status-bar poll fire nearly
   *  simultaneously on open) share one in-flight fetch instead of each fanning
   *  out its own pair of requests.
   *
   *  `needsActionAuthors` (the persisted `perforce.swarm.needsActionAuthors` set)
   *  adds a server-side `author=` query whose open reviews are folded into
   *  needsAction. This covers reviews the user is only associated with through a
   *  Swarm project/group (no individual reviewer role) — `participants=me` alone
   *  never returns those (the filter does NOT expand group/project membership).
   *  Empty set → no extra query → identical to the participants-only behavior.
   *
   *  A `keywords` filter is pushed down to the underlying review-list query so
   *  the server narrows results instead of the renderer fetching everything and
   *  filtering in memory. Keyword queries bypass the unfiltered in-flight
   *  coalescing (which exists to share the status-bar + first-load fan-out); the
   *  per-filter TTL cache in {@link listReviews} still dedups repeats.
   *
   *  `windowDays` (> 0) drops reviews whose last-updated time is older than that
   *  many days. Swarm's `GET /reviews` has no native "updated since" filter (only
   *  author / state / participants are honored), so this window is applied
   *  client-side here after the lists come back. 0 / undefined = no time limit. */
  async dashboard(
    opts: {
      force?: boolean
      keywords?: string
      needsActionAuthors?: readonly string[]
      windowDays?: number
    } = {},
  ): Promise<SwarmDashboard> {
    const me = this._config.user
    if (!me) return { needsAction: [], authored: [], participating: [] }
    const keywords = opts.keywords?.trim() ? opts.keywords.trim() : undefined
    const force = opts.force ?? false
    const authors = opts.needsActionAuthors?.length ? opts.needsActionAuthors : undefined
    const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : undefined
    const key = `${authors ? [...authors].sort().join(',') : ''}|${windowDays ?? 0}`
    if (keywords !== undefined) {
      if (force) this._cache.invalidateNamespace(SwarmCacheNs.reviewList)
      return this._loadDashboard(me, keywords, authors, windowDays)
    }
    if (this._dashboardInFlight && this._dashboardInFlightKey === key) {
      if (!force || this._dashboardInFlightIsForce) return this._dashboardInFlight
      if (this._dashboardQueuedForce) return this._dashboardQueuedForce
      const queued = this._dashboardInFlight
        .then(() =>
          this.dashboard({
            force: true,
            ...(authors ? { needsActionAuthors: authors } : {}),
            ...(windowDays ? { windowDays } : {}),
          }),
        )
        .finally(() => {
          if (this._dashboardQueuedForce === queued) this._dashboardQueuedForce = undefined
        })
      this._dashboardQueuedForce = queued
      return queued
    }
    if (force) this._cache.invalidateNamespace(SwarmCacheNs.reviewList)
    this._dashboardInFlightIsForce = force
    this._dashboardInFlightKey = key
    const run = this._loadDashboard(me, undefined, authors, windowDays).finally(() => {
      if (this._dashboardInFlight === run) {
        this._dashboardInFlight = undefined
        this._dashboardInFlightIsForce = false
        this._dashboardInFlightKey = ''
      }
    })
    this._dashboardInFlight = run
    return run
  }

  private async _loadDashboard(
    me: string,
    keywords?: string,
    needsActionAuthors?: readonly string[],
    windowDays?: number,
  ): Promise<SwarmDashboard> {
    // needsAction is derived locally from authored + participating + the
    // needsActionAuthors query (see deriveNeedsAction). We deliberately do NOT
    // call `dashboards/action`: it is a v9-only endpoint that is redundant with
    // this derivation and, on many Swarm deployments, slow enough that a fronting
    // gateway 504s on it — there is no upside to paying that request.
    const [authoredRaw, participatingRaw, byAuthorRaw] = await Promise.all([
      this.listReviews({ author: [me], max: 50, ...(keywords ? { keywords } : {}) }).then(
        (r) => r.reviews,
      ),
      this.listReviews({ participants: [me], max: 50, ...(keywords ? { keywords } : {}) }).then(
        (r) => r.reviews,
      ),
      needsActionAuthors?.length
        ? this.listReviews({
            author: [...needsActionAuthors],
            state: ['needsReview', 'needsRevision'],
            max: 50,
            ...(keywords ? { keywords } : {}),
          }).then((r) => r.reviews)
        : Promise.resolve<SwarmReview[]>([]),
    ])
    // Swarm can't filter by "updated since" server-side, so apply the time window
    // here. A review with no updated time (0) is kept — never hide on missing data.
    const cutoff = windowDays && windowDays > 0 ? this._now() - windowDays * DAY_MS : undefined
    const withinWindow = (reviews: SwarmReview[]): SwarmReview[] =>
      cutoff === undefined ? reviews : reviews.filter((r) => !r.updated || r.updated >= cutoff)
    const authored = withinWindow(authoredRaw)
    const participating = withinWindow(participatingRaw)
    const byAuthor = withinWindow(byAuthorRaw)
    return {
      needsAction: deriveNeedsAction(me, authored, participating, byAuthor),
      authored,
      participating,
    }
  }

  /** Full detail of one review. */
  async getReview(
    id: string,
    force = false,
  ): Promise<(SwarmReviewDetail & { transitions: SwarmTransition[] }) | undefined> {
    if (force) {
      this._cache.invalidate(SwarmCacheNs.reviewDetail, id)
      this._cache.invalidate(SwarmCacheNs.transitions, id)
    }
    const [detailRaw, transitions] = await Promise.all([
      this._cache.wrap(SwarmCacheNs.reviewDetail, id, async () => {
        const raw = await this._api.get(`reviews/${encodeURIComponent(id)}`)
        const detail = parseReviewDetail(raw)
        return detail ? JSON.stringify(detail) : undefined
      }),
      this.getTransitions(id).catch(() => [] as SwarmTransition[]),
    ])
    if (!detailRaw) return undefined
    const detail = JSON.parse(detailRaw) as SwarmReviewDetail
    return { ...detail, transitions }
  }

  /** Legal state transitions for the current user (server-authoritative). */
  async getTransitions(id: string): Promise<SwarmTransition[]> {
    const cached = await this._cache.wrap(SwarmCacheNs.transitions, id, async () => {
      const raw = await this._api.get(`reviews/${encodeURIComponent(id)}/transitions`)
      return JSON.stringify(parseTransitions(raw))
    })
    return JSON.parse(cached as string) as SwarmTransition[]
  }

  /** Create a review from a shelved changelist. Returns the new review id. */
  async createReview(req: {
    change: string
    description?: string
    reviewers?: string[]
    requiredReviewers?: string[]
  }): Promise<string | undefined> {
    const body: Record<string, unknown> = { change: req.change }
    if (req.description) body['description'] = req.description
    if (req.reviewers?.length) body['reviewers'] = req.reviewers
    if (req.requiredReviewers?.length) body['requiredReviewers'] = req.requiredReviewers
    const raw = await this._api.post('reviews', body)
    const id = parseCreatedReviewId(raw)
    this._invalidateReviewLists()
    return id
  }

  /** Associate a new change (version) with a review. */
  async addChange(
    id: string,
    change: string,
    mode: 'replace' | 'append' = 'append',
  ): Promise<void> {
    await this._api.post(`reviews/${encodeURIComponent(id)}/changes`, { change, mode })
    this._invalidateReview(id)
  }

  /** Vote on a review version. */
  async vote(id: string, vote: 'up' | 'down' | 'clear', version?: number): Promise<void> {
    const body: Record<string, unknown> = { vote }
    if (version !== undefined) body['version'] = version
    await this._api.post(`reviews/${encodeURIComponent(id)}/vote`, body)
    this._invalidateReview(id)
  }

  /** Transition a review's state (optionally committing on approve). */
  async transition(
    id: string,
    state: string,
    opts?: { commit?: boolean; description?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = { state }
    if (opts?.commit) body['commit'] = true
    if (opts?.description) body['description'] = opts.description
    await this._api.patch(`reviews/${encodeURIComponent(id)}/state`, body)
    this._invalidateReview(id)
  }

  /** Permanently remove a review. This is distinct from archiving it. */
  async obliterateReview(id: string): Promise<void> {
    await this._api.post(`reviews/${encodeURIComponent(id)}/obliterate`)
  }

  /** List comments on a review. Swarm comments are a topic-based resource:
   *  `GET /comments?topic=reviews/{id}` (NOT a nested `comments/reviews/{id}`). */
  async listComments(
    id: string,
    opts?: { tasksOnly?: boolean; max?: number; after?: string; force?: boolean },
  ): Promise<SwarmComment[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      topic: `reviews/${id}`,
    }
    if (opts?.tasksOnly) query['tasksOnly'] = true
    if (opts?.max) query['max'] = opts.max
    if (opts?.after) query['after'] = opts.after
    const key = commentFilterKey(id, opts)
    if (opts?.force) this._cache.invalidate(SwarmCacheNs.comments, key)
    const cached = await this._cache.wrap(SwarmCacheNs.comments, key, async () => {
      const raw = await this._api.get('comments', { query })
      return JSON.stringify(parseComments(raw))
    })
    return JSON.parse(cached as string) as SwarmComment[]
  }

  /** Add a comment (review-level or file-line) to a review. */
  async addComment(
    id: string,
    body: string,
    opts?: {
      taskState?: string
      context?: {
        file?: string
        leftLine?: number
        rightLine?: number
        content?: string[]
        version?: number
      }
    },
  ): Promise<SwarmComment | undefined> {
    const payload: Record<string, unknown> = { topic: `reviews/${id}`, body }
    if (opts?.taskState) payload['taskState'] = opts.taskState
    if (opts?.context) payload['context'] = opts.context
    const raw = await this._api.post('comments', payload)
    const root = (raw ?? {}) as Record<string, unknown>
    const rec = (root['comment'] ?? root) as Record<string, unknown>
    const comment = parseComments({ comments: [rec] })[0]
    this._invalidateReview(id)
    return comment
  }

  /** Change a comment's task state (open / addressed / verified).
   *  Swarm edits a comment via `PATCH /comments/{id}` (no `/edit` sub-path). */
  async setTaskState(reviewId: string, commentId: string, taskState: string): Promise<void> {
    await this._api.patch(`comments/${encodeURIComponent(commentId)}`, { taskState })
    this._invalidateReview(reviewId)
  }

  dispose(): void {
    this._cache.clear()
  }

  private _invalidateReview(id: string): void {
    this._cache.invalidate(SwarmCacheNs.reviewDetail, id)
    this._cache.invalidate(SwarmCacheNs.transitions, id)
    this._cache.invalidateNamespace(SwarmCacheNs.comments)
    this._invalidateReviewLists()
    this._logger?.debug('client', `invalidated cached review #${id}`)
  }

  private _invalidateReviewLists(): void {
    this._cache.invalidateNamespace(SwarmCacheNs.reviewList)
  }
}

function reviewFilterKey(filter: SwarmReviewFilter): string {
  const sorted = (values: string[] | undefined): string[] | null =>
    values?.length ? [...values].sort() : null
  return JSON.stringify({
    author: sorted(filter.author),
    participants: sorted(filter.participants),
    state: sorted(filter.state),
    keywords: filter.keywords ?? null,
    max: filter.max ?? 50,
    after: filter.after ?? null,
  })
}

function commentFilterKey(
  id: string,
  opts?: { tasksOnly?: boolean; max?: number; after?: string },
): string {
  return JSON.stringify({
    id,
    tasksOnly: opts?.tasksOnly ?? false,
    max: opts?.max ?? null,
    after: opts?.after ?? null,
  })
}

/**
 * Local fallback for the `dashboards/action` endpoint (v9-only): approximate the
 * "needs my action" set from the reviews the user authored, participates in, or
 * that were pulled by the configured needsActionAuthors query (covers reviews the
 * user is only linked to through a Swarm project/group). A review is actionable
 * while it is still open (needsReview / needsRevision); approved / rejected /
 * archived reviews are done. Deduped by id, authored first.
 */
function deriveNeedsAction(
  _me: string,
  authored: SwarmReview[],
  participating: SwarmReview[],
  byAuthor: SwarmReview[] = [],
): SwarmReview[] {
  const seen = new Set<string>()
  const out: SwarmReview[] = []
  for (const r of [...authored, ...participating, ...byAuthor]) {
    if (seen.has(r.id)) continue
    if (r.state !== 'needsReview' && r.state !== 'needsRevision') continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}
