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

export class SwarmClient {
  private readonly _api: SwarmApi
  /** Coalesces concurrent dashboard() callers (view + status bar) onto one fetch. */
  private _dashboardInFlight: Promise<SwarmDashboard> | undefined

  constructor(
    private readonly _p4: P4Service,
    private readonly _config: SwarmClientConfig,
    private readonly _logger?: SwarmLogger,
  ) {
    this._api = new SwarmApi({
      baseUrl: _config.baseUrl,
      apiVersion: _config.apiVersion,
      getAuth: () => this._auth(),
      ...(_logger ? { logger: _logger } : {}),
    })
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
    const raw = await this._api.get('reviews', { query })
    return parseReviewList(raw)
  }

  /** The action-dashboard grouping: needs-my-action / authored / participating.
   *  Concurrent callers (the sidebar view + the status-bar poll fire nearly
   *  simultaneously on open) share one in-flight fetch instead of each fanning
   *  out its own pair of requests. */
  async dashboard(): Promise<SwarmDashboard> {
    if (this._dashboardInFlight) return this._dashboardInFlight
    const run = this._dashboard().finally(() => {
      this._dashboardInFlight = undefined
    })
    this._dashboardInFlight = run
    return run
  }

  private async _dashboard(): Promise<SwarmDashboard> {
    const me = this._config.user
    if (!me) return { needsAction: [], authored: [], participating: [] }
    // needsAction is derived locally from authored + participating (see
    // deriveNeedsAction). We deliberately do NOT call `dashboards/action`: it is a
    // v9-only endpoint that is redundant with this derivation and, on many Swarm
    // deployments, slow enough that a fronting gateway 504s on it — there is no
    // upside to paying that request.
    const [authored, participating] = await Promise.all([
      this.listReviews({ author: [me], max: 50 }).then((r) => r.reviews),
      this.listReviews({ participants: [me], max: 50 }).then((r) => r.reviews),
    ])
    return {
      needsAction: deriveNeedsAction(me, authored, participating),
      authored,
      participating,
    }
  }

  /** Full detail of one review. */
  async getReview(
    id: string,
  ): Promise<(SwarmReviewDetail & { transitions: SwarmTransition[] }) | undefined> {
    const [detailRaw, transitions] = await Promise.all([
      this._api.get(`reviews/${encodeURIComponent(id)}`),
      this.getTransitions(id).catch(() => [] as SwarmTransition[]),
    ])
    const detail = parseReviewDetail(detailRaw)
    if (!detail) return undefined
    return { ...detail, transitions }
  }

  /** Legal state transitions for the current user (server-authoritative). */
  async getTransitions(id: string): Promise<SwarmTransition[]> {
    const raw = await this._api.get(`reviews/${encodeURIComponent(id)}/transitions`)
    return parseTransitions(raw)
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
    return parseCreatedReviewId(raw)
  }

  /** Associate a new change (version) with a review. */
  async addChange(
    id: string,
    change: string,
    mode: 'replace' | 'append' = 'append',
  ): Promise<void> {
    await this._api.post(`reviews/${encodeURIComponent(id)}/changes`, { change, mode })
  }

  /** Vote on a review version. */
  async vote(id: string, vote: 'up' | 'down' | 'clear', version?: number): Promise<void> {
    const body: Record<string, unknown> = { vote }
    if (version !== undefined) body['version'] = version
    await this._api.post(`reviews/${encodeURIComponent(id)}/vote`, body)
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
  }

  /** List comments on a review. Swarm comments are a topic-based resource:
   *  `GET /comments?topic=reviews/{id}` (NOT a nested `comments/reviews/{id}`). */
  async listComments(
    id: string,
    opts?: { tasksOnly?: boolean; max?: number; after?: string },
  ): Promise<SwarmComment[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      topic: `reviews/${id}`,
    }
    if (opts?.tasksOnly) query['tasksOnly'] = true
    if (opts?.max) query['max'] = opts.max
    if (opts?.after) query['after'] = opts.after
    const raw = await this._api.get('comments', { query })
    return parseComments(raw)
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
    return parseComments({ comments: [rec] })[0]
  }

  /** Change a comment's task state (open / addressed / verified).
   *  Swarm edits a comment via `PATCH /comments/{id}` (no `/edit` sub-path). */
  async setTaskState(commentId: string, taskState: string): Promise<void> {
    await this._api.patch(`comments/${encodeURIComponent(commentId)}`, { taskState })
  }
}

/**
 * Local fallback for the `dashboards/action` endpoint (v9-only): approximate the
 * "needs my action" set from the reviews the user authored or participates in.
 * A review is actionable while it is still open (needsReview / needsRevision);
 * approved / rejected / archived reviews are done. Deduped by id, authored first.
 */
function deriveNeedsAction(
  _me: string,
  authored: SwarmReview[],
  participating: SwarmReview[],
): SwarmReview[] {
  const seen = new Set<string>()
  const out: SwarmReview[] = []
  for (const r of [...authored, ...participating]) {
    if (seen.has(r.id)) continue
    if (r.state !== 'needsReview' && r.state !== 'needsRevision') continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}
