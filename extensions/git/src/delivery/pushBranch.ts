/**
 * Push a session worktree's branch to its remote. This is deliberately separate
 * from `deliveryGit`: delivery moves main, while this only publishes the
 * session branch. Safety invariants: never force-push, never change a branch's
 * upstream when it already points elsewhere, and refuse a diverged remote
 * instead of rewriting it.
 */
import { detectRepoRoot } from '../gitService.js'
import { pendingOperation } from '../worktreeSync.js'
import { samePath } from '../pathUtil.js'
import {
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  currentBranch,
  currentHead,
  divergence,
  fetchRemote,
  isAncestor,
  listWorktrees,
  readWorktreeStatus,
  resolveRef,
  resolveUpstream,
  runDeliveryGit,
  type Log,
} from './deliveryGit.js'
import type { DeliveryFailure, DeliveryResult } from './deliveryTypes.js'

export interface PushBranchInspectInput {
  readonly sourceCwd: string
  readonly remote?: string
  readonly remoteBranch?: string
  readonly fetch?: boolean
}

export interface PushBranchSourceInfo {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
  readonly dirty: boolean
  readonly changedFileCount: number
  readonly untrackedCount: number
  readonly pendingOperation?: string
  readonly isMainWorktree: boolean
}

export interface PushBranchRemoteInfo {
  readonly name: string
  readonly branch: string
  readonly exists: boolean
  readonly head?: string
  readonly ahead: number
  readonly behind: number
}

export interface PushBranchInspectData {
  readonly source: PushBranchSourceInfo
  readonly remote: PushBranchRemoteInfo
  readonly blockers: readonly DeliveryFailure[]
  readonly warnings: readonly string[]
  readonly fetched: boolean
}

export type PushBranchInspectResult = DeliveryResult<PushBranchInspectData>

export interface PushBranchExecuteInput {
  readonly sourceCwd: string
  readonly expectedBranch: string
  readonly expectedHead: string
  readonly remote: string
  readonly remoteBranch: string
  readonly expectedRemoteHead?: string
  readonly fetch?: boolean
}

export interface PushBranchExecuteData {
  readonly branch: string
  readonly head: string
  readonly remote: string
  readonly remoteBranch: string
  readonly published: boolean
}

export type PushBranchExecuteResult = DeliveryResult<PushBranchExecuteData>

const failure = (
  code: DeliveryFailure['code'],
  message: string,
  detail?: string,
): DeliveryFailure => ({
  code,
  message,
  ...(detail !== undefined ? { detail } : {}),
})

const fail = <T>(
  code: DeliveryFailure['code'],
  message: string,
  detail?: string,
): DeliveryResult<T> => ({ ok: false, error: failure(code, message, detail) })

const okData = <T extends object>(data: T): DeliveryResult<T> => ({ ok: true, ...data })

const gitErrorText = (res: { readonly stderr: string; readonly stdout: string }): string =>
  res.stderr.trim() || res.stdout.trim()

const listRemotes = async (cwd: string, log?: Log): Promise<string[] | undefined> => {
  const res = await runDeliveryGit(['remote'], cwd, log, { timeoutMs: LOCAL_TIMEOUT_MS })
  if (res.exitCode !== 0) return undefined
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** `git check-ref-format` rejects `..`, leading `-` and other refspec hazards. */
const isValidBranchName = async (cwd: string, name: string, log?: Log): Promise<boolean> => {
  if (name.length === 0 || name.startsWith('-') || name.startsWith('/')) return false
  const res = await runDeliveryGit(['check-ref-format', `refs/heads/${name}`], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  return res.exitCode === 0
}

const resolveRemote = async (
  sourceWorktree: string,
  branch: string,
  requested: string | undefined,
  log?: Log,
): Promise<
  { readonly remote: string; readonly branch: string } | { readonly error: DeliveryFailure }
> => {
  const remotes = await listRemotes(sourceWorktree, log)
  if (remotes === undefined) {
    return { error: failure('git_failed', 'Could not list git remotes.') }
  }
  const upstream = await resolveUpstream(sourceWorktree, branch, log)
  const remote =
    requested?.trim() ||
    upstream?.remote ||
    (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : undefined)
  if (remote === undefined) {
    return {
      error: failure('no_remote', `Branch '${branch}' has no upstream and no default remote.`),
    }
  }
  if (!remotes.includes(remote)) {
    return { error: failure('no_remote', `Remote '${remote}' does not exist.`) }
  }
  // Keep the local name unless the caller names another branch: an upstream
  // such as origin/dev must not silently repoint a feature branch on push.
  return { remote, branch: branch }
}

const remoteTrackingRef = (remote: string, branch: string): string =>
  `refs/remotes/${remote}/${branch}`

export async function inspectPushBranch(
  input: PushBranchInspectInput,
  log?: Log,
): Promise<PushBranchInspectResult> {
  if (typeof input?.sourceCwd !== 'string' || input.sourceCwd.length === 0) {
    return fail('not_a_repository', 'The session has no working directory.')
  }
  const sourceWorktree = await detectRepoRoot(input.sourceCwd)
  if (sourceWorktree === undefined) {
    return fail('not_a_repository', 'The session working directory is not inside a git repository.')
  }

  const branch = await currentBranch(sourceWorktree, log)
  if (branch === undefined) {
    return fail('detached_source', 'The source worktree is in detached HEAD state.')
  }
  const head = await currentHead(sourceWorktree, log)
  if (head === undefined) return fail('source_missing', 'Could not read the source worktree HEAD.')

  const resolved = await resolveRemote(sourceWorktree, branch, input.remote, log)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const remote = resolved.remote
  const remoteBranch = input.remoteBranch?.trim() || branch
  if (!(await isValidBranchName(sourceWorktree, remoteBranch, log))) {
    return fail('invalid_branch', `'${remoteBranch}' is not a valid branch name.`)
  }

  const status = await readWorktreeStatus(sourceWorktree, log)
  if (status === undefined) {
    return fail('git_failed', 'Could not read git status for the source worktree.')
  }
  const sourcePending = await pendingOperation(sourceWorktree, log)
  const dirty = status.files.length > 0
  const worktrees = await listWorktrees(sourceWorktree, log)
  const main = worktrees?.find((worktree) => worktree.isMain)

  let fetched = false
  if (input.fetch !== false) {
    const fetch = await fetchRemote(sourceWorktree, remote, log)
    if (fetch.exitCode !== 0) {
      return fail('fetch_failed', `Fetching '${remote}' failed.`, gitErrorText(fetch))
    }
    fetched = true
  }

  const remoteHead = await resolveRef(sourceWorktree, remoteTrackingRef(remote, remoteBranch), log)
  const counts =
    remoteHead !== undefined
      ? await divergence(sourceWorktree, head, remoteHead, log)
      : { ahead: 0, behind: 0 }
  if (counts === undefined) {
    return fail('git_failed', `Could not compare '${branch}' with '${remote}/${remoteBranch}'.`)
  }

  const blockers: DeliveryFailure[] = []
  if (sourcePending !== undefined) {
    blockers.push(
      failure('source_in_progress', `The source worktree has a ${sourcePending} in progress.`),
    )
  }
  if (remoteHead !== undefined && counts.behind > 0) {
    blockers.push(
      failure(
        'remote_diverged',
        'The remote branch has commits you do not have. Reconcile it on the PC before pushing.',
      ),
    )
  } else if (remoteHead !== undefined && counts.ahead === 0) {
    blockers.push(failure('nothing_to_push', 'Everything on this branch is already on the remote.'))
  }

  const warnings: string[] = []
  if (dirty) {
    warnings.push('Uncommitted changes are not included; only commits are pushed.')
  }

  const data: PushBranchInspectData = {
    source: {
      worktree: sourceWorktree,
      branch,
      head,
      dirty,
      changedFileCount: status.files.length,
      untrackedCount: status.files.filter((file) => file.kind === 'untracked').length,
      ...(sourcePending !== undefined ? { pendingOperation: sourcePending } : {}),
      isMainWorktree: main !== undefined && samePath(main.path, sourceWorktree),
    },
    remote: {
      name: remote,
      branch: remoteBranch,
      exists: remoteHead !== undefined,
      ...(remoteHead !== undefined ? { head: remoteHead } : {}),
      ahead: counts.ahead,
      behind: counts.behind,
    },
    blockers,
    warnings,
    fetched,
  }
  return okData(data)
}

export async function pushBranch(
  input: PushBranchExecuteInput,
  log?: Log,
): Promise<PushBranchExecuteResult> {
  if (typeof input?.sourceCwd !== 'string' || input.sourceCwd.length === 0) {
    return fail('not_a_repository', 'The session has no working directory.')
  }
  const sourceWorktree = await detectRepoRoot(input.sourceCwd)
  if (sourceWorktree === undefined) {
    return fail('not_a_repository', 'The session working directory is not inside a git repository.')
  }

  const branch = await currentBranch(sourceWorktree, log)
  if (branch === undefined) {
    return fail('detached_source', 'The source worktree is in detached HEAD state.')
  }
  if (branch !== input.expectedBranch) {
    return fail('head_mismatch', 'The source worktree moved to another branch.')
  }
  const head = await currentHead(sourceWorktree, log)
  if (head === undefined) return fail('source_missing', 'Could not read the source worktree HEAD.')
  if (head !== input.expectedHead) {
    return fail('head_mismatch', 'The source worktree moved before the push started.')
  }

  const remotes = await listRemotes(sourceWorktree, log)
  if (remotes === undefined) return fail('git_failed', 'Could not list git remotes.')
  if (!remotes.includes(input.remote)) {
    return fail('no_remote', `Remote '${input.remote}' does not exist.`)
  }
  if (!(await isValidBranchName(sourceWorktree, input.remoteBranch, log))) {
    return fail('invalid_branch', `'${input.remoteBranch}' is not a valid branch name.`)
  }
  const pendingSource = await pendingOperation(sourceWorktree, log)
  if (pendingSource !== undefined) {
    return fail('source_in_progress', `The source worktree has a ${pendingSource} in progress.`)
  }

  if (input.fetch !== false) {
    const fetch = await fetchRemote(sourceWorktree, input.remote, log)
    if (fetch.exitCode !== 0) {
      return fail('fetch_failed', `Fetching '${input.remote}' failed.`, gitErrorText(fetch))
    }
  }

  const remoteHead = await resolveRef(
    sourceWorktree,
    remoteTrackingRef(input.remote, input.remoteBranch),
    log,
  )
  if (input.expectedRemoteHead !== remoteHead) {
    return fail('remote_moved', 'The remote branch moved before the push started.')
  }
  if (remoteHead !== undefined) {
    if (remoteHead === head) {
      return fail('nothing_to_push', 'Everything on this branch is already on the remote.')
    }
    const fastForward = await isAncestor(sourceWorktree, remoteHead, head, log)
    if (fastForward === undefined) {
      return fail('git_failed', `Could not compare '${branch}' with its remote branch.`)
    }
    if (!fastForward) {
      return fail(
        'remote_diverged',
        'The remote branch has commits you do not have. Reconcile it on the PC before pushing.',
      )
    }
  }

  const upstream = await resolveUpstream(sourceWorktree, branch, log)
  const args = ['push', '--porcelain']
  if (upstream === undefined) args.push('--set-upstream')
  args.push(input.remote, `HEAD:refs/heads/${input.remoteBranch}`)
  const pushed = await runDeliveryGit(args, sourceWorktree, log, {
    timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (pushed.exitCode !== 0) {
    return fail('push_failed', `Pushing '${branch}' failed.`, gitErrorText(pushed))
  }

  const listed = await runDeliveryGit(
    ['ls-remote', '--heads', input.remote, `refs/heads/${input.remoteBranch}`],
    sourceWorktree,
    log,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (listed.exitCode !== 0) {
    return fail('push_failed', 'Could not verify the pushed branch.', gitErrorText(listed))
  }
  const remoteRef = `refs/heads/${input.remoteBranch}`
  const line = listed.stdout
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.endsWith(`\t${remoteRef}`))
  const pushedSha = line?.slice(0, line.indexOf('\t'))
  if (pushedSha !== head) {
    return fail('push_failed', 'The remote branch did not move to the pushed commit.')
  }

  return okData({
    branch,
    head,
    remote: input.remote,
    remoteBranch: input.remoteBranch,
    published: remoteHead === undefined,
  })
}
