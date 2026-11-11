/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin typed client over the git extension's `git.agentDelivery.*` commands.
 *  The renderer owns the delivery state machine; every git write happens inside
 *  the extension (local or remote host), never in the main process.
 *--------------------------------------------------------------------------------------------*/

import {
  ICommandService,
  InstantiationType,
  createDecorator,
  registerSingleton,
} from '@universe-editor/platform'
import type {
  SessionDeliveryCommit,
  SessionDeliveryErrorCode,
  SessionDeliveryWorktreeResult,
} from './sessionDeliveryTypes.js'

export interface DeliveryGitFailure {
  readonly code: string
  readonly message: string
  readonly detail?: string
}

export type DeliveryGitResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: DeliveryGitFailure }

export interface DeliveryGitRepositoryInfo {
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

export interface DeliveryGitSourceInfo {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
  readonly dirty: boolean
  readonly changedFileCount: number
  readonly untrackedCount: number
  readonly pendingOperation?: string
  readonly isMainWorktree: boolean
}

export interface DeliveryGitInspectData {
  readonly repository: DeliveryGitRepositoryInfo
  readonly source: DeliveryGitSourceInfo
  readonly commits: readonly SessionDeliveryCommit[]
  readonly baseSha: string
  readonly blockers: readonly DeliveryGitFailure[]
  readonly warnings: readonly string[]
}

export interface DeliveryGitBeginData {
  readonly mainHeadBefore: string
  readonly mainHeadAfter: string
  readonly upstreamHead: string
  readonly mainBranch: string
  readonly remote: string
  readonly upstreamRef: string
  readonly fetched: boolean
}

export interface DeliveryGitCommitSourceData {
  readonly head: string
  readonly commit: SessionDeliveryCommit
}

export interface DeliveryGitPickData {
  readonly status: 'picked' | 'conflict'
  readonly tempWorktree: string
  readonly tempHead: string
  readonly picked: readonly SessionDeliveryCommit[]
  readonly skippedEmpty: readonly string[]
  readonly remainingCommits: readonly string[]
  readonly conflictFiles: readonly string[]
  readonly conflictedCommit?: SessionDeliveryCommit
}

export interface DeliveryGitPromoteAndPushData {
  readonly pushedSha: string
  readonly mainHead: string
  readonly remoteRef: string
}

export interface DeliveryGitSyncData {
  readonly results: readonly DeliveryWorktreeResult[]
}

/** Extension shape; `status` is the extension's worktree sync status. */
export interface DeliveryWorktreeResult {
  readonly name: string
  readonly path: string
  readonly branch?: string
  readonly status: SessionDeliveryWorktreeResult['status']
  readonly error?: string
}

export interface DeliveryGitUndoData {
  readonly mainHead: string
  readonly revertedShas: readonly string[]
  readonly remoteRef: string
}

export interface DeliveryGitChangeFile {
  readonly path: string
  readonly status: string
  readonly diff: string
}

export interface DeliveryGitChangeContextData {
  readonly files: readonly DeliveryGitChangeFile[]
  readonly totalFiles: number
  readonly truncated: boolean
  readonly fingerprint: string
  readonly statusText: string
}

export interface DeliveryGitLockOwner {
  readonly token: string
  readonly pid: number
  readonly hostname: string
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly label?: string
}

export interface DeliveryGitAcquireLockData {
  readonly acquired: boolean
  readonly owner?: DeliveryGitLockOwner
}

export interface ISessionDeliveryGit {
  readonly _serviceBrand: undefined
  inspect(input: {
    sourceCwd: string
    targetBranch?: string
    fetch?: boolean
  }): Promise<DeliveryGitResult<DeliveryGitInspectData>>
  acquireLock(input: {
    commonDir: string
    token: string
    label?: string
  }): Promise<DeliveryGitResult<DeliveryGitAcquireLockData>>
  heartbeatLock(input: {
    commonDir: string
    token: string
  }): Promise<DeliveryGitResult<{ heartbeatAt: string }>>
  releaseLock(input: {
    commonDir: string
    token: string
  }): Promise<DeliveryGitResult<{ released: boolean }>>
  begin(input: DeliveryGitBeginInput): Promise<DeliveryGitResult<DeliveryGitBeginData>>
  commitSource(input: {
    commonDir: string
    deliveryId: string
    token: string
    sourceWorktree: string
    expectedSourceHead: string
    message: string
  }): Promise<DeliveryGitResult<DeliveryGitCommitSourceData>>
  preparePick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    sourceWorktree: string
    baseSha: string
    sourceHead: string
    commits: readonly string[]
  }): Promise<DeliveryGitResult<DeliveryGitPickData>>
  continuePick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    tempWorktree: string
    remainingCommits: readonly string[]
    conflictFiles: readonly string[]
    expectedTempHead?: string
  }): Promise<DeliveryGitResult<DeliveryGitPickData>>
  abortPick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    tempWorktree: string
  }): Promise<DeliveryGitResult<{ removed: boolean }>>
  promoteAndPush(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    targetBranch: string
    baseSha: string
    tempWorktree: string
    tempHead: string
    remote: string
    upstreamRef: string
  }): Promise<DeliveryGitResult<DeliveryGitPromoteAndPushData>>
  restoreMain(input: {
    mainWorktree: string
    expectedCurrentHead: string
    restoreToHead: string
    targetBranch?: string
  }): Promise<DeliveryGitResult<{ head: string }>>
  syncWorktrees(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    newHead: string
    sourceWorktree: string
    expectedSourceHead: string
    tempWorktree?: string
  }): Promise<DeliveryGitResult<DeliveryGitSyncData>>
  undo(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    targetBranch: string
    pushedSha: string
    deliveredShas: readonly string[]
    remote: string
    upstreamRef: string
  }): Promise<DeliveryGitResult<DeliveryGitUndoData>>
  changeContext(input: {
    sourceWorktree: string
    maxFiles?: number
    maxChars?: number
  }): Promise<DeliveryGitResult<DeliveryGitChangeContextData>>
}

export interface DeliveryGitBeginInput {
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

export const ISessionDeliveryGit = createDecorator<ISessionDeliveryGit>('sessionDeliveryGit')

const COMMAND_PREFIX = 'git.agentDelivery.'

export class SessionDeliveryGit implements ISessionDeliveryGit {
  declare readonly _serviceBrand: undefined

  constructor(@ICommandService private readonly _commands: ICommandService) {}

  inspect(input: {
    sourceCwd: string
    targetBranch?: string
    fetch?: boolean
  }): Promise<DeliveryGitResult<DeliveryGitInspectData>> {
    return this._run<DeliveryGitInspectData>('inspect', input)
  }

  acquireLock(input: {
    commonDir: string
    token: string
    label?: string
  }): Promise<DeliveryGitResult<DeliveryGitAcquireLockData>> {
    return this._run<DeliveryGitAcquireLockData>('acquireLock', input)
  }

  heartbeatLock(input: {
    commonDir: string
    token: string
  }): Promise<DeliveryGitResult<{ heartbeatAt: string }>> {
    return this._run<{ heartbeatAt: string }>('heartbeatLock', input)
  }

  releaseLock(input: {
    commonDir: string
    token: string
  }): Promise<DeliveryGitResult<{ released: boolean }>> {
    return this._run<{ released: boolean }>('releaseLock', input)
  }

  begin(input: DeliveryGitBeginInput): Promise<DeliveryGitResult<DeliveryGitBeginData>> {
    return this._run<DeliveryGitBeginData>('begin', input)
  }

  commitSource(input: {
    commonDir: string
    deliveryId: string
    token: string
    sourceWorktree: string
    expectedSourceHead: string
    message: string
  }): Promise<DeliveryGitResult<DeliveryGitCommitSourceData>> {
    return this._run<DeliveryGitCommitSourceData>('commitSource', input)
  }

  preparePick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    sourceWorktree: string
    baseSha: string
    sourceHead: string
    commits: readonly string[]
  }): Promise<DeliveryGitResult<DeliveryGitPickData>> {
    return this._run<DeliveryGitPickData>('preparePick', input)
  }

  continuePick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    tempWorktree: string
    remainingCommits: readonly string[]
    conflictFiles: readonly string[]
    expectedTempHead?: string
  }): Promise<DeliveryGitResult<DeliveryGitPickData>> {
    return this._run<DeliveryGitPickData>('continuePick', input)
  }

  abortPick(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    tempWorktree: string
  }): Promise<DeliveryGitResult<{ removed: boolean }>> {
    return this._run<{ removed: boolean }>('abortPick', input)
  }

  promoteAndPush(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    targetBranch: string
    baseSha: string
    tempWorktree: string
    tempHead: string
    remote: string
    upstreamRef: string
  }): Promise<DeliveryGitResult<DeliveryGitPromoteAndPushData>> {
    return this._run<DeliveryGitPromoteAndPushData>('promoteAndPush', input)
  }

  restoreMain(input: {
    mainWorktree: string
    expectedCurrentHead: string
    restoreToHead: string
  }): Promise<DeliveryGitResult<{ head: string }>> {
    return this._run<{ head: string }>('restoreMain', input)
  }

  syncWorktrees(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    newHead: string
    sourceWorktree: string
    expectedSourceHead: string
    tempWorktree?: string
  }): Promise<DeliveryGitResult<DeliveryGitSyncData>> {
    return this._run<DeliveryGitSyncData>('syncWorktrees', input)
  }

  undo(input: {
    commonDir: string
    deliveryId: string
    token: string
    mainWorktree: string
    targetBranch: string
    pushedSha: string
    deliveredShas: readonly string[]
    remote: string
    upstreamRef: string
  }): Promise<DeliveryGitResult<DeliveryGitUndoData>> {
    return this._run<DeliveryGitUndoData>('undo', input)
  }

  changeContext(input: {
    sourceWorktree: string
    maxFiles?: number
    maxChars?: number
  }): Promise<DeliveryGitResult<DeliveryGitChangeContextData>> {
    return this._run<DeliveryGitChangeContextData>('changeContext', input)
  }

  private async _run<T>(command: string, input: unknown): Promise<DeliveryGitResult<T>> {
    try {
      const result = await this._commands.executeCommand(`${COMMAND_PREFIX}${command}`, input)
      if (typeof result !== 'object' || result === null) {
        return {
          ok: false,
          error: {
            code: 'git_failed',
            message: `git delivery command '${command}' returned no result`,
          },
        }
      }
      return result as DeliveryGitResult<T>
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'unsupported',
          message: `git delivery command '${command}' failed`,
          detail: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }
}

/** Maps an extension failure onto the renderer's error-code union. */
export function deliveryErrorFromGit(failure: DeliveryGitFailure): {
  code: SessionDeliveryErrorCode
  message: string
  detail?: string
} {
  const known: readonly SessionDeliveryErrorCode[] = [
    'not_a_repository',
    'not_a_worktree_repository',
    'bare_repository',
    'no_main_worktree',
    'detached_main',
    'target_branch_mismatch',
    'no_upstream',
    'upstream_changed',
    'main_dirty',
    'main_in_progress',
    'main_diverged',
    'main_moved',
    'main_ff_failed',
    'source_missing',
    'source_dirty',
    'source_in_progress',
    'nothing_to_deliver',
    'nothing_to_commit',
    'merge_commit_unsupported',
    'head_mismatch',
    'lock_held',
    'lock_lost',
    'fetch_failed',
    'git_failed',
    'invalid_message',
    'conflict',
    'source_changed',
    'temp_worktree_failed',
    'push_failed',
    'remote_moved',
    'unsupported',
  ]
  const code = known.find((candidate) => candidate === failure.code) ?? 'git_failed'
  return {
    code,
    message: failure.message,
    ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
  }
}

registerSingleton(ISessionDeliveryGit, SessionDeliveryGit, InstantiationType.Delayed)
