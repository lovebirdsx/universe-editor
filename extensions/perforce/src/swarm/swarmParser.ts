/**
 * Pure Swarm JSON → domain-model parsers. No I/O — every function takes a raw
 * decoded JSON value and returns a plain object matching the wire DTO shapes in
 * `@universe-editor/extensions-common` (`packages/extensions-common/src/swarm.ts`),
 * the single source of truth. The `Dto`-less local names below are `import type`
 * aliases of those DTOs, so a wire-field rename breaks this parser's compile
 * immediately while keeping the package out of the esbuild bundle. Tolerant of
 * missing / differently-shaped fields across Swarm API versions (v9 vs v11):
 * unknown fields are ignored and absent ones fall back to safe defaults, so a
 * schema drift degrades to a partial record rather than a throw. Unit-tested
 * against fixtures.
 */
import type {
  SwarmReviewState as SwarmReviewStateDto,
  SwarmTaskState as SwarmTaskStateDto,
  SwarmReviewDto,
  SwarmParticipantDto,
  SwarmVersionDto,
  SwarmReviewDetailDto,
  SwarmTransitionDto,
  SwarmCommentDto,
} from '@universe-editor/extensions-common'

export type SwarmReviewState = SwarmReviewStateDto

export type SwarmTaskState = SwarmTaskStateDto

export type SwarmReview = SwarmReviewDto

export type SwarmParticipant = SwarmParticipantDto

export type SwarmVersion = SwarmVersionDto

/** The parsed review detail *before* the client attaches the legal transitions
 *  (fetched from a separate endpoint), hence the omit — {@link parseReviewDetail}
 *  never produces `transitions` itself. */
export type SwarmReviewDetail = Omit<SwarmReviewDetailDto, 'transitions'>

export type SwarmTransition = SwarmTransitionDto

export type SwarmComment = SwarmCommentDto

const REVIEW_STATES: readonly SwarmReviewState[] = [
  'needsReview',
  'needsRevision',
  'approved',
  'rejected',
  'archived',
]

const TASK_STATES: readonly SwarmTaskState[] = ['comment', 'open', 'addressed', 'verified']

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

function coerceState(v: unknown): SwarmReviewState {
  const s = asString(v)
  return s && (REVIEW_STATES as readonly string[]).includes(s)
    ? (s as SwarmReviewState)
    : 'needsReview'
}

function coerceTaskState(v: unknown): SwarmTaskState {
  const s = asString(v)
  return s && (TASK_STATES as readonly string[]).includes(s) ? (s as SwarmTaskState) : 'comment'
}

/** Swarm timestamps are Unix *seconds*; the DTOs use ms. Normalize here. */
function toMillis(v: unknown): number {
  const n = asNumber(v)
  return n === undefined ? 0 : n < 1e12 ? n * 1000 : n
}

function coerceTestStatus(v: unknown): 'pass' | 'fail' | 'running' | 'none' {
  const s = asString(v)?.toLowerCase()
  if (s === 'pass' || s === 'fail' || s === 'running') return s
  return 'none'
}

/**
 * Participants come in two shapes across versions: an object map
 * `{ user: { vote: { value, isRequired } } }` (v9/v11) or an array of usernames.
 * A separate `requiredReviewers` array may flag required members. Returns
 * normalized participant records plus derived up/down vote counts.
 */
function parseParticipants(raw: unknown, required: ReadonlySet<string>): SwarmParticipant[] {
  const out: SwarmParticipant[] = []
  if (Array.isArray(raw)) {
    for (const u of raw) {
      const user = asString(u)
      if (user) out.push({ user, required: required.has(user), vote: 0 })
    }
    return out
  }
  if (raw && typeof raw === 'object') {
    for (const [user, data] of Object.entries(raw as Record<string, unknown>)) {
      let vote = 0
      let req = required.has(user)
      if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>
        const voteData = d['vote']
        if (voteData && typeof voteData === 'object') {
          vote = asNumber((voteData as Record<string, unknown>)['value']) ?? 0
          const isReq = (voteData as Record<string, unknown>)['isRequired']
          if (isReq === true) req = true
        } else {
          vote = asNumber(voteData) ?? 0
        }
        if (d['required'] === true || d['isRequired'] === true) req = true
      }
      out.push({ user, required: req, vote })
    }
  }
  return out
}

function requiredSet(raw: unknown): Set<string> {
  const set = new Set<string>()
  if (Array.isArray(raw)) {
    for (const u of raw) {
      const s = asString(u)
      if (s) set.add(s)
    }
  }
  return set
}

function parseVersions(raw: unknown): SwarmVersion[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry, i) => {
    const r = (entry ?? {}) as Record<string, unknown>
    const archiveChange = asString(r['archiveChange'])
    return {
      version: asNumber(r['rev']) ?? i + 1,
      change: asString(r['change']) ?? asString(r['stream']) ?? '',
      ...(archiveChange ? { archiveChange } : {}),
      pending: r['pending'] !== false,
      time: toMillis(r['time']),
    }
  })
}

/** `comments` on a review is often `[total, openTasks]` (a two-element counter);
 *  fall back to a plain number or object. Returns [commentCount, openTaskCount]. */
function parseCommentCounts(raw: unknown): [number, number] {
  if (Array.isArray(raw)) {
    return [asNumber(raw[0]) ?? 0, asNumber(raw[1]) ?? 0]
  }
  const n = asNumber(raw)
  return [n ?? 0, 0]
}

/** Parse one review record (the `review` object, or a list element). */
export function parseReview(raw: Record<string, unknown>): SwarmReview | undefined {
  const id = asString(raw['id'])
  if (!id) return undefined
  const required = requiredSet(raw['requiredReviewers'])
  const participants = parseParticipants(raw['participants'], required)
  const description = asString(raw['description']) ?? ''
  const [commentCount, openTaskCount] = parseCommentCounts(raw['comments'])
  return {
    id,
    state: coerceState(raw['state']),
    stateLabel: asString(raw['stateLabel']) ?? asString(raw['state']) ?? '',
    author: asString(raw['author']) ?? '',
    description: firstLine(description),
    upVotes: participants.filter((p) => p.vote > 0).length,
    downVotes: participants.filter((p) => p.vote < 0).length,
    commentCount,
    openTaskCount,
    testStatus: coerceTestStatus(raw['testStatus']),
    updated: toMillis(raw['updated']),
  }
}

/** Parse a list response `{ reviews: [...], lastSeen: N }`. */
export function parseReviewList(raw: unknown): { reviews: SwarmReview[]; lastSeen: string | null } {
  const root = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(root['reviews']) ? root['reviews'] : []
  const reviews: SwarmReview[] = []
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const parsed = parseReview(entry as Record<string, unknown>)
      if (parsed) reviews.push(parsed)
    }
  }
  const lastSeen = asString(root['lastSeen']) ?? null
  return { reviews, lastSeen }
}

/** Parse the detail response `{ review: {...} }` (or a bare review object). */
export function parseReviewDetail(raw: unknown): SwarmReviewDetail | undefined {
  const root = (raw ?? {}) as Record<string, unknown>
  const rec = (root['review'] ?? root) as Record<string, unknown>
  const id = asString(rec['id'])
  if (!id) return undefined
  const required = requiredSet(rec['requiredReviewers'])
  const description = asString(rec['description']) ?? ''
  const [commentCount, openTaskCount] = parseCommentCounts(rec['comments'])
  return {
    id,
    state: coerceState(rec['state']),
    stateLabel: asString(rec['stateLabel']) ?? asString(rec['state']) ?? '',
    author: asString(rec['author']) ?? '',
    description,
    updated: toMillis(rec['updated']),
    versions: parseVersions(rec['versions']),
    participants: parseParticipants(rec['participants'], required),
    commentCount,
    openTaskCount,
    testStatus: coerceTestStatus(rec['testStatus']),
  }
}

/**
 * Parse `GET /reviews/{id}/transitions`. Swarm returns
 * `{ transitions: { needsReview: "Needs Review", approved: "Approve", ... } }`
 * (a state-key → label map), or occasionally an array. Composite keys like
 * `approved:commit` are preserved verbatim.
 */
export function parseTransitions(raw: unknown): SwarmTransition[] {
  const root = (raw ?? {}) as Record<string, unknown>
  const t = root['transitions']
  const out: SwarmTransition[] = []
  if (Array.isArray(t)) {
    for (const entry of t) {
      const s = asString(entry)
      if (s) out.push({ state: s, label: s })
      else if (entry && typeof entry === 'object') {
        const r = entry as Record<string, unknown>
        const state = asString(r['state'] ?? r['key'])
        if (state) out.push({ state, label: asString(r['label']) ?? state })
      }
    }
    return out
  }
  if (t && typeof t === 'object') {
    for (const [state, label] of Object.entries(t as Record<string, unknown>)) {
      out.push({ state, label: asString(label) ?? state })
    }
  }
  return out
}

/** Parse one comment record. */
export function parseComment(raw: Record<string, unknown>): SwarmComment | undefined {
  const id = asString(raw['id'])
  if (!id) return undefined
  const ctxRaw = raw['context']
  let context: SwarmComment['context']
  if (ctxRaw && typeof ctxRaw === 'object') {
    const c = ctxRaw as Record<string, unknown>
    const file = asString(c['file'])
    const leftLine = asNumber(c['leftLine'])
    const rightLine = asNumber(c['rightLine'])
    const version = asNumber(c['version'])
    if (file !== undefined || leftLine !== undefined || rightLine !== undefined) {
      context = {
        ...(file !== undefined ? { file } : {}),
        ...(leftLine !== undefined ? { leftLine } : {}),
        ...(rightLine !== undefined ? { rightLine } : {}),
        ...(version !== undefined ? { version } : {}),
      }
    }
  }
  return {
    id,
    body: asString(raw['body']) ?? '',
    author: asString(raw['user']) ?? asString(raw['author']) ?? '',
    taskState: coerceTaskState(raw['taskState']),
    updated: toMillis(raw['updated'] ?? raw['time']),
    ...(context ? { context } : {}),
  }
}

/** Parse a comments response `{ comments: [...] }`. */
export function parseComments(raw: unknown): SwarmComment[] {
  const root = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(root['comments'])
    ? root['comments']
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const out: SwarmComment[] = []
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const parsed = parseComment(entry as Record<string, unknown>)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

/** Extract a created review's id from a `POST /reviews` response. */
export function parseCreatedReviewId(raw: unknown): string | undefined {
  const root = (raw ?? {}) as Record<string, unknown>
  const rec = (root['review'] ?? root) as Record<string, unknown>
  return asString(rec['id'])
}
