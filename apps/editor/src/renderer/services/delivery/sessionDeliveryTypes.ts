/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side view of an agent delivery: the pipeline that commits a child
 *  worktree's changes, cherry-picks them onto main in a temporary worktree, and
 *  pushes only after the phone confirms. The git primitives live in the built-in
 *  git extension; these shapes are the renderer's own record (persisted) plus
 *  the protocol-facing summary/detail projections.
 *
 *  Absolute paths never cross the phone wire: protocol summaries/details expose
 *  worktree names only. Records keep paths for the git extension calls.
 *--------------------------------------------------------------------------------------------*/

export type SessionDeliveryPhase =
  | 'preflighting'
  | 'committing'
  | 'cherry_picking'
  | 'resolving_conflict'
  | 'awaiting_push'
  | 'pushing'
  | 'syncing'
  | 'synced'
  | 'partial'
  | 'failed'
  | 'undoing'
  | 'undone'

export type SessionDeliveryErrorCode =
  | 'not_a_repository'
  | 'not_a_worktree_repository'
  | 'bare_repository'
  | 'no_main_worktree'
  | 'detached_main'
  | 'detached_source'
  | 'target_branch_mismatch'
  | 'no_upstream'
  | 'no_remote'
  | 'upstream_changed'
  | 'main_dirty'
  | 'main_in_progress'
  | 'main_diverged'
  | 'main_moved'
  | 'main_ff_failed'
  | 'source_missing'
  | 'source_dirty'
  | 'source_in_progress'
  | 'nothing_to_deliver'
  | 'nothing_to_commit'
  | 'nothing_to_push'
  | 'merge_commit_unsupported'
  | 'head_mismatch'
  | 'lock_held'
  | 'lock_lost'
  | 'fetch_failed'
  | 'git_failed'
  | 'invalid_message'
  | 'invalid_branch'
  | 'conflict'
  | 'temp_worktree_failed'
  | 'push_failed'
  | 'push_unverified'
  | 'remote_moved'
  | 'remote_diverged'
  | 'unsupported'
  | 'busy'
  | 'session_running'
  | 'not_found'
  | 'side_task_failed'
  | 'source_changed'

export interface SessionDeliveryError {
  readonly code: SessionDeliveryErrorCode
  readonly message: string
  readonly detail?: string
}

export interface SessionDeliveryCommit {
  readonly sha: string
  readonly shortSha: string
  readonly subject: string
  readonly author: string
  readonly authoredAt: string
}

export type SessionDeliveryWorktreeStatus =
  | 'synced'
  | 'up_to_date'
  | 'skipped_dirty'
  | 'skipped_in_progress'
  | 'skipped_diverged'
  | 'skipped_source_changed'
  | 'failed'

export interface SessionDeliveryWorktreeResult {
  readonly name: string
  readonly branch?: string
  readonly status: SessionDeliveryWorktreeStatus
  readonly error?: string
}

export interface SessionDeliverySource {
  readonly sessionLocalId?: string
  readonly sessionDurableId?: string
  readonly agentId: string
  readonly cwd: string
  readonly worktree: string
  readonly branch?: string
  /** Source HEAD when the delivery started. */
  readonly head: string
  readonly authority?: string
}

export interface SessionDeliveryTarget {
  readonly mainWorktree: string
  readonly mainBranch: string
  readonly targetBranch: string
  readonly remote: string
  readonly remoteBranch: string
  readonly upstreamRef: string
  readonly baseSha: string
  readonly upstreamHead: string
  readonly aheadOfUpstream: number
}

export interface SessionDeliveryRecord {
  readonly id: string
  readonly repositoryKey: string
  /** Git common dir; every git-extension command needs it. */
  readonly commonDir: string
  readonly phase: SessionDeliveryPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly attempt: number
  readonly source: SessionDeliverySource
  readonly target: SessionDeliveryTarget
  /** Whether the source worktree had uncommitted changes at start. */
  readonly sourceDirty: boolean
  /** Set when the source was committed by a side task during this delivery. */
  readonly generatedMessage?: string
  readonly commits: readonly SessionDeliveryCommit[]
  readonly skippedEmpty: readonly string[]
  readonly tempWorktree?: string
  readonly tempHead?: string
  readonly conflictFiles: readonly string[]
  readonly conflictedCommit?: SessionDeliveryCommit
  readonly mainHeadBefore?: string
  readonly mainHeadAfter?: string
  readonly pushedSha?: string
  readonly remoteRef?: string
  readonly syncResults: readonly SessionDeliveryWorktreeResult[]
  readonly undo?: SessionDeliveryUndoResult
  readonly error?: SessionDeliveryError
  /** Which operation failed, so retry can resume it instead of starting over. */
  readonly failedAction?: 'delivery' | 'undo'
  /** Held while a delivery is active; released on completion/abort. */
  readonly lockToken?: string
  /** Renderer instance that acquired `lockToken`; other windows must not reuse it. */
  readonly lockInstanceId?: string
}

export interface SessionDeliveryUndoResult {
  readonly at: number
  readonly revertedShas: readonly string[]
  readonly mainHead: string
}

/**
 * Heads pinned by the preview and re-checked before the first git write. A
 * preview that goes stale must be refreshed so the commit range stays valid.
 */
export interface SessionDeliveryExpectation {
  readonly mainHead: string
  readonly mainBranch: string
  readonly targetBranch: string
  readonly remote: string
  readonly remoteBranch: string
  readonly upstreamRef: string
  readonly upstreamHead: string
  readonly sourceHead: string
  readonly baseSha: string
  readonly commits: readonly string[]
}

export interface SessionDeliveryPreview {
  readonly source: {
    readonly worktree: string
    readonly branch?: string
    readonly head: string
    readonly dirty: boolean
    readonly changedFileCount: number
    readonly untrackedCount: number
    readonly pendingOperation?: string
    readonly isMainWorktree: boolean
  }
  readonly target: SessionDeliveryTarget
  readonly commits: readonly SessionDeliveryCommit[]
  readonly blockers: readonly SessionDeliveryError[]
  readonly warnings: readonly string[]
  readonly forkSupported: boolean
  readonly expectation: SessionDeliveryExpectation
}

export type SessionDeliveryPreviewResult =
  | { readonly ok: true; readonly preview: SessionDeliveryPreview }
  | { readonly ok: false; readonly error: SessionDeliveryError }

export interface SessionDeliveryStartResult {
  readonly deliveryId: string
}

/** Revisions the phone echoes back; the bridge re-checks the ones it can. */
export interface SessionDeliveryStartExpectation {
  readonly mainHead: string
  readonly mainBranch: string
  readonly targetBranch: string
  readonly remote: string
  readonly remoteBranch: string
  readonly upstreamRef: string
  readonly upstreamHead: string
  readonly sourceHead: string
  readonly baseSha: string
  readonly commits: readonly string[]
}

export interface SessionDeliverySyncSummary {
  readonly synced: number
  readonly upToDate: number
  readonly skipped: number
  readonly failed: number
}

/** Protocol-facing condensed row, mirrored into a session's inbox summary. */
export interface SessionDeliverySummary {
  readonly deliveryId: string
  readonly phase: SessionDeliveryPhase
  readonly commitCount: number
  readonly dirtySource: boolean
  readonly mainBranch: string
  readonly updatedAt: number
  readonly error?: SessionDeliveryError
  readonly canConfirmPush: boolean
  readonly canRetry: boolean
  readonly canUndo: boolean
  readonly sync: SessionDeliverySyncSummary
}

/** Protocol-facing detail. Only worktree names, never absolute paths. */
export interface SessionDeliveryDetail {
  readonly summary: SessionDeliverySummary
  readonly source: {
    readonly worktreeName: string
    readonly branch?: string
    readonly head: string
    readonly dirty: boolean
  }
  readonly target: {
    readonly mainWorktreeName: string
    readonly mainBranch: string
    readonly remote: string
    readonly remoteBranch: string
    readonly upstreamRef: string
    readonly baseSha: string
    readonly mainHead: string
  }
  readonly commits: readonly SessionDeliveryCommit[]
  readonly generatedMessage?: string
  readonly conflictFiles: readonly string[]
  readonly conflictedCommit?: SessionDeliveryCommit
  readonly pushedSha?: string
  readonly remoteRef?: string
  readonly syncResults: readonly SessionDeliveryWorktreeResult[]
  readonly undo?: SessionDeliveryUndoResult
}

export interface SessionDeliveryChange {
  readonly deliveryId: string
  readonly sessionLocalId?: string
  readonly sessionDurableId?: string
  /** Removed when the record was pruned; otherwise the current record. */
  readonly record?: SessionDeliveryRecord
}

/** Context main needs to route/guard a phone delivery command. */
export interface SessionDeliveryContext {
  readonly sourceCwd: string
  readonly authority?: string
  readonly deliveryId?: string
  readonly phase?: SessionDeliveryPhase
  readonly mainWorktree?: string
}

export const ACTIVE_DELIVERY_PHASES: readonly SessionDeliveryPhase[] = [
  'preflighting',
  'committing',
  'cherry_picking',
  'resolving_conflict',
  'awaiting_push',
  'pushing',
  'syncing',
  'undoing',
]

export function isActiveDeliveryPhase(phase: SessionDeliveryPhase): boolean {
  return ACTIVE_DELIVERY_PHASES.includes(phase)
}

export function worktreeName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

export function syncSummary(
  results: readonly SessionDeliveryWorktreeResult[],
): SessionDeliverySyncSummary {
  let synced = 0
  let upToDate = 0
  let skipped = 0
  let failed = 0
  for (const result of results) {
    switch (result.status) {
      case 'synced':
        synced++
        break
      case 'up_to_date':
        upToDate++
        break
      case 'failed':
        failed++
        break
      default:
        skipped++
        break
    }
  }
  return { synced, upToDate, skipped, failed }
}

export function toDeliverySessionKey(entry: {
  readonly sessionLocalId?: string
  readonly sessionDurableId?: string
}): string | undefined {
  return entry.sessionDurableId ?? entry.sessionLocalId
}
