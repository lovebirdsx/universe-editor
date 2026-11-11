/**
 * Wire types for the agent-delivery git commands. The renderer orchestrates the
 * pipeline; this module only exposes the git primitives it needs. Every command
 * takes a single object argument so the renderer can forward it through the
 * extension-host command proxy unchanged.
 */

export type DeliveryErrorCode =
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
  | 'source_changed'
  | 'temp_worktree_failed'
  | 'push_failed'
  | 'remote_moved'
  | 'remote_diverged'
  | 'unsupported'

export interface DeliveryFailure {
  readonly code: DeliveryErrorCode
  readonly message: string
  readonly detail?: string
}

export type DeliveryResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: DeliveryFailure }

export interface DeliveryRepositoryInfo {
  readonly commonDir: string
  readonly mainWorktree: string
  readonly mainBranch: string
  readonly targetBranch: string
  readonly remote: string
  readonly remoteBranch: string
  readonly upstreamRef: string
  readonly mainHead: string
  readonly upstreamHead: string
  readonly aheadOfUpstream: number
  readonly behindUpstream: number
  readonly canFastForward: boolean
}

export interface DeliverySourceInfo {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
  readonly dirty: boolean
  readonly changedFileCount: number
  readonly untrackedCount: number
  readonly pendingOperation?: string
  readonly isMainWorktree: boolean
}

export interface DeliveryCommitInfo {
  readonly sha: string
  readonly shortSha: string
  readonly subject: string
  readonly author: string
  readonly authoredAt: string
}

export interface DeliveryInspectInput {
  readonly sourceCwd: string
  readonly targetBranch?: string
  readonly fetch?: boolean
}

export interface DeliveryInspectData {
  readonly repository: DeliveryRepositoryInfo
  readonly source: DeliverySourceInfo
  readonly commits: readonly DeliveryCommitInfo[]
  readonly baseSha: string
  readonly blockers: readonly DeliveryFailure[]
  readonly warnings: readonly string[]
}

export type DeliveryInspectResult = DeliveryResult<DeliveryInspectData>

export interface DeliveryBeginInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly sourceCwd: string
  readonly targetBranch: string
  readonly expectedMainHead: string
  readonly expectedUpstreamHead: string
  readonly expectedSourceHead: string
  readonly remote: string
  readonly upstreamRef: string
}

export interface DeliveryBeginData {
  readonly mainHeadBefore: string
  readonly mainHeadAfter: string
  readonly upstreamHead: string
  readonly mainBranch: string
  readonly remote: string
  readonly upstreamRef: string
  readonly fetched: boolean
}

export type DeliveryBeginResult = DeliveryResult<DeliveryBeginData>

export interface DeliveryCommitSourceInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly sourceWorktree: string
  readonly expectedSourceHead: string
  readonly message: string
}

export interface DeliveryCommitSourceData {
  readonly head: string
  readonly commit: DeliveryCommitInfo
}

export type DeliveryCommitSourceResult = DeliveryResult<DeliveryCommitSourceData>

export interface DeliveryPreparePickInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly sourceWorktree: string
  readonly baseSha: string
  readonly sourceHead: string
  readonly commits: readonly string[]
  readonly tempRoot?: string
}

export interface DeliveryContinuePickInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly tempWorktree: string
  readonly remainingCommits: readonly string[]
  /** Files the resolver is allowed to touch; anything else aborts the pick. */
  readonly conflictFiles: readonly string[]
  readonly expectedTempHead?: string
}

export interface DeliveryAbortPickInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  /** Defaults to the path `preparePick` derives from `deliveryId`. */
  readonly tempWorktree?: string
}

export type DeliveryPickStatus = 'picked' | 'conflict'

export interface DeliveryPickData {
  readonly status: DeliveryPickStatus
  readonly tempWorktree: string
  readonly tempHead: string
  readonly picked: readonly DeliveryCommitInfo[]
  readonly skippedEmpty: readonly string[]
  readonly remainingCommits: readonly string[]
  readonly conflictFiles: readonly string[]
  readonly conflictedCommit?: DeliveryCommitInfo
}

export type DeliveryPickResult = DeliveryResult<DeliveryPickData>
export type DeliveryAbortPickResult = DeliveryResult<{ readonly removed: boolean }>

export interface DeliveryPromoteAndPushInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly targetBranch: string
  readonly baseSha: string
  readonly tempWorktree: string
  readonly tempHead: string
  readonly remote: string
  readonly upstreamRef: string
}

export interface DeliveryPromoteAndPushData {
  readonly pushedSha: string
  readonly mainHead: string
  readonly remoteRef: string
}

export type DeliveryPromoteAndPushResult = DeliveryResult<DeliveryPromoteAndPushData>

export interface DeliveryRestoreMainInput {
  readonly mainWorktree: string
  readonly expectedCurrentHead: string
  readonly restoreToHead: string
  readonly targetBranch?: string
}

export interface DeliveryRestoreMainData {
  readonly head: string
}

export type DeliveryRestoreMainResult = DeliveryResult<DeliveryRestoreMainData>

export type DeliveryWorktreeSyncStatus =
  | 'synced'
  | 'up_to_date'
  | 'skipped_dirty'
  | 'skipped_in_progress'
  | 'skipped_diverged'
  | 'skipped_source_changed'
  | 'failed'

export interface DeliveryWorktreeSyncResult {
  readonly name: string
  readonly path: string
  readonly branch?: string
  readonly status: DeliveryWorktreeSyncStatus
  readonly error?: string
}

export interface DeliverySyncWorktreesInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly newHead: string
  readonly sourceWorktree: string
  readonly expectedSourceHead: string
  readonly tempWorktree?: string
}

export interface DeliverySyncWorktreesData {
  readonly results: readonly DeliveryWorktreeSyncResult[]
}

export type DeliverySyncWorktreesResult = DeliveryResult<DeliverySyncWorktreesData>

export interface DeliveryUndoInput {
  readonly commonDir: string
  readonly deliveryId: string
  readonly token: string
  readonly mainWorktree: string
  readonly targetBranch: string
  readonly pushedSha: string
  readonly deliveredShas: readonly string[]
  readonly remote: string
  readonly upstreamRef: string
}

export interface DeliveryUndoData {
  readonly mainHead: string
  readonly revertedShas: readonly string[]
  readonly remoteRef: string
}

export type DeliveryUndoResult = DeliveryResult<DeliveryUndoData>

export interface DeliveryChangeContextInput {
  readonly sourceWorktree: string
  readonly maxFiles?: number
  readonly maxChars?: number
}

export interface DeliveryChangeFile {
  readonly path: string
  readonly status: string
  readonly diff: string
}

export interface DeliveryChangeContextData {
  readonly files: readonly DeliveryChangeFile[]
  readonly totalFiles: number
  readonly truncated: boolean
  readonly fingerprint: string
  readonly statusText: string
}

export type DeliveryChangeContextResult = DeliveryResult<DeliveryChangeContextData>

export interface DeliveryLockOwner {
  readonly token: string
  readonly pid: number
  readonly hostname: string
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly label?: string
}

export interface DeliveryAcquireLockInput {
  readonly commonDir: string
  readonly token: string
  readonly label?: string
}

export interface DeliveryAcquireLockData {
  readonly acquired: boolean
  readonly owner?: DeliveryLockOwner
}

export type DeliveryAcquireLockResult = DeliveryResult<DeliveryAcquireLockData>

export interface DeliveryLockTokenInput {
  readonly commonDir: string
  readonly token: string
}

export type DeliveryLockResult = DeliveryResult<{ readonly released: boolean }>
