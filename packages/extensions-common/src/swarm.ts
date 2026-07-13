/**
 * Swarm (P4 Code Review) wire types, shared by the renderer (which calls the
 * commands) and, structurally, by the `perforce` extension's `swarm/` submodule
 * (which implements them — it keeps local copies of these shapes to avoid
 * bundling this package).
 *
 * Data crosses the contributed-command boundary as plain JSON: the renderer
 * calls `commands.executeCommand(SwarmCommands.*, ...)` and the extension's
 * handler returns one of the DTOs below.
 *
 * Swarm is a review layer over Helix Core: a review tracks a *shelved
 * changelist*, and each re-shelve produces a new *version*. State transitions
 * are decided server-side (moderation), never computed on the client. Dates are
 * Unix milliseconds unless noted.
 */

/** The fixed Swarm review state machine (server-authoritative). */
export type SwarmReviewState =
  | 'needsReview'
  | 'needsRevision'
  | 'approved'
  | 'rejected'
  | 'archived'

/** A single vote on a review, bound to a version. */
export interface SwarmVoteDto {
  /** The voting user. */
  user: string
  /** +1 (up), -1 (down), 0 (cleared). */
  value: number
  /** Whether this reviewer is required. */
  required: boolean
}

/** A review as shown in the list view (trimmed fields). */
export interface SwarmReviewDto {
  /** Review id (also the Swarm change id backing it), as a string. */
  id: string
  /** Machine state. */
  state: SwarmReviewState
  /** Localized / human label for the state, as Swarm reports it. */
  stateLabel: string
  /** The review author (p4 user). */
  author: string
  /** Description first line. */
  description: string
  /** Up-vote count. */
  upVotes: number
  /** Down-vote count. */
  downVotes: number
  /** Total comment count (all threads). */
  commentCount: number
  /** Open (unresolved) task count. */
  openTaskCount: number
  /** Automated test status, when Swarm tracks it. */
  testStatus: 'pass' | 'fail' | 'running' | 'none'
  /** Last-updated time, Unix ms. */
  updated: number
}

/** One participant (reviewer) on a review. */
export interface SwarmParticipantDto {
  user: string
  /** Whether this reviewer is required (must up-vote to approve). */
  required: boolean
  /** This participant's vote: 1 / -1 / 0 (no vote). */
  vote: number
}

/** One version of a review — a shelved (or committed) change snapshot. */
export interface SwarmVersionDto {
  /** 1-based version number. */
  version: number
  /** The p4 change backing this version. */
  change: string
  /** Whether this version is committed (vs shelved). */
  pending: boolean
  /** Version creation time, Unix ms. */
  time: number
}

/** A file changed in a review version. */
export interface SwarmReviewFileDto {
  /** Single-letter status derived from the Swarm action: A/M/D/R. */
  status: string
  /** Display path (depot path without the leading `//`). */
  path: string
  /** Full depot path, for p4 operations. */
  depotFile: string
}

/** Full review detail loaded when a review is opened. */
export interface SwarmReviewDetailDto {
  id: string
  state: SwarmReviewState
  stateLabel: string
  author: string
  /** Full description (all lines). */
  description: string
  updated: number
  versions: SwarmVersionDto[]
  participants: SwarmParticipantDto[]
  /** Legal transitions for the current user (from GET /reviews/{id}/transitions);
   *  the UI only offers these — it never computes permission itself. */
  transitions: SwarmTransitionDto[]
  commentCount: number
  openTaskCount: number
  testStatus: 'pass' | 'fail' | 'running' | 'none'
}

/** A legal state transition the current user may apply. */
export interface SwarmTransitionDto {
  /** Target state key (needsReview / needsRevision / approved / rejected / archived,
   *  or a composite like `approved:commit`). */
  state: string
  /** Human label for the transition button. */
  label: string
}

/** The task state machine on a comment: comment → open → addressed → verified. */
export type SwarmTaskState = 'comment' | 'open' | 'addressed' | 'verified'

/** A comment on a review (review-level, file-line, or reply). */
export interface SwarmCommentDto {
  id: string
  body: string
  author: string
  /** Task state; 'comment' means it isn't a task. */
  taskState: SwarmTaskState
  /** Last-updated time, Unix ms. */
  updated: number
  /** Location context; absent for review-level comments. */
  context?: SwarmCommentContext
}

/** Where a comment is anchored. Absent → review-level. */
export interface SwarmCommentContext {
  /** Depot file the comment is on. */
  file?: string
  /** 1-based line on the left (base) side. */
  leftLine?: number
  /** 1-based line on the right (target) side. */
  rightLine?: number
  /** The version this comment was made against. */
  version?: number
}

/** Filter parameters for the review list (maps to GET /reviews query). */
export interface SwarmReviewFilter {
  /** Reviews authored by these users. */
  author?: string[]
  /** Reviews these users participate in. */
  participants?: string[]
  /** States to include. */
  state?: SwarmReviewState[]
  /** Free-text keyword search. */
  keywords?: string
  /** Page size. */
  max?: number
  /** Opaque pagination cursor (Swarm `after`). */
  after?: string
}

/** One page of reviews. */
export interface SwarmReviewListResult {
  reviews: SwarmReviewDto[]
  /** Cursor to pass as `after` for the next page, or null when exhausted. */
  lastSeen: string | null
}

/** The action-dashboard grouping the list view renders. */
export interface SwarmDashboardResult {
  /** Reviews needing the current user's action (reviewer, not yet voted / recalled). */
  needsAction: SwarmReviewDto[]
  /** Reviews the current user authored. */
  authored: SwarmReviewDto[]
  /** Reviews the current user participates in (voted / commented / joined). */
  participating: SwarmReviewDto[]
}

/** Argument for `perforce.swarm.createReview`. */
export interface SwarmCreateReviewRequest {
  /** The changelist to review (must be numbered + shelved). */
  changelist: string
  /** Review description (defaults to the CL description). */
  description?: string
  /** Optional reviewers. */
  reviewers?: string[]
  /** Optional required reviewers. */
  requiredReviewers?: string[]
}

/** Argument for `perforce.swarm.vote`. */
export interface SwarmVoteRequest {
  reviewId: string
  vote: 'up' | 'down' | 'clear'
  version?: number
}

/** Argument for `perforce.swarm.transition`. */
export interface SwarmTransitionRequest {
  reviewId: string
  /** Target state key from a {@link SwarmTransitionDto}. */
  state: string
  /** When approving, also commit the shelved change to the depot. Irreversible —
   *  the command layer confirms first. */
  commit?: boolean
  /** Optional description / message attached to the transition. */
  description?: string
}

/** Argument for `perforce.swarm.addChange` — associate a new version (author
 *  closure: re-shelve then link the change to the review). */
export interface SwarmAddChangeRequest {
  reviewId: string
  /** The p4 change to link as a new version. */
  change: string
  /** Whether to replace the current version's files or append. */
  mode?: 'replace' | 'append'
}

/** Argument for `perforce.swarm.updateReview` — the author re-shelves the given
 *  changelist and links it to the review as a new version. */
export interface SwarmUpdateReviewRequest {
  reviewId: string
  /** The changelist to re-shelve; defaults to prompting the user. */
  changelist?: string
}

/** Argument for `perforce.swarm.addComment`. */
export interface SwarmAddCommentRequest {
  reviewId: string
  body: string
  /** Mark the comment as an open task. */
  asTask?: boolean
  /** Anchor to a file line (inline comment). Absent → review-level. */
  context?: SwarmCommentContext
  /** For inline comments: the anchored line plus a few preceding lines, so Swarm
   *  can re-anchor after the file drifts (API requirement). */
  content?: string[]
}

/** Argument for `perforce.swarm.setTaskState`. */
export interface SwarmSetTaskStateRequest {
  commentId: string
  taskState: SwarmTaskState
}

/** Argument for `perforce.swarm.getFileDiff` — the two version snapshots to compare. */
export interface SwarmFileDiffRequest {
  reviewId: string
  depotFile: string
  /** Left (base) version's backing change; null for an added file. */
  fromChange: string | null
  /** Right (target) version's backing change; null for a deleted file. */
  toChange: string | null
}

/**
 * Contributed-command ids the `perforce` extension's swarm submodule registers.
 * Kept here as the single source of truth for the renderer side.
 *
 * NOTE on the shadowing guardrail (memory `renderer-action-shadowed-by-extension-
 * command-decl`): every id below has its handler in the extension host, so they
 * are safe to declare in package.json `commands`. Any command whose handler lives
 * in a renderer Action2 (e.g. "open review list") must NOT be added here or to the
 * package.json `commands` array — only to `menus`.
 */
export const SwarmCommands = {
  /** Connectivity self-check: returns a short status string. */
  ping: 'perforce.swarm.ping',
  listReviews: 'perforce.swarm.listReviews',
  dashboard: 'perforce.swarm.dashboard',
  getReview: 'perforce.swarm.getReview',
  createReview: 'perforce.swarm.createReview',
  vote: 'perforce.swarm.vote',
  transition: 'perforce.swarm.transition',
  addChange: 'perforce.swarm.addChange',
  updateReview: 'perforce.swarm.updateReview',
  updateReviewFromChangelist: 'perforce.swarm.updateReviewFromChangelist',
  listComments: 'perforce.swarm.listComments',
  addComment: 'perforce.swarm.addComment',
  setTaskState: 'perforce.swarm.setTaskState',
  getFileContent: 'perforce.swarm.getFileContent',
  describeVersion: 'perforce.swarm.describeVersion',
} as const

export type SwarmCommandId = (typeof SwarmCommands)[keyof typeof SwarmCommands]
