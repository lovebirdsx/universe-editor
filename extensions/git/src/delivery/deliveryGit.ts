/**
 * Git primitives for delivering a session's commits to the main branch. All
 * writes stay inside this extension: the renderer orchestrates, this module runs
 * the git commands. A temporary detached worktree carries the cherry-picked
 * commits, so the main working tree only moves once the user confirms the push.
 *
 * Safety invariants: never force-push, never stash, never reset a worktree that
 * has commits of its own, and only move main when it still sits on the commit
 * the caller expects.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { GitExecResult } from '../gitService.js'
import { detectGitDirs, detectRepoRoot, gitExec } from '../gitService.js'
import { gitErrorText } from '../gitError.js'
import { samePath } from '../pathUtil.js'
import { parseStatus, type GitStatus } from '../statusParser.js'
import { hasSubmodules } from '../submoduleSync.js'
import { parseWorktrees, type WorktreeInfo } from '../worktreeParser.js'
import { pendingOperation } from '../worktreeSync.js'
import { isDeliveryLockHeld } from './deliveryLock.js'
import type {
  DeliveryAbortPickInput,
  DeliveryAbortPickResult,
  DeliveryBeginData,
  DeliveryBeginInput,
  DeliveryBeginResult,
  DeliveryCommitInfo,
  DeliveryCommitSourceData,
  DeliveryCommitSourceInput,
  DeliveryCommitSourceResult,
  DeliveryContinuePickInput,
  DeliveryErrorCode,
  DeliveryFailure,
  DeliveryInspectData,
  DeliveryInspectInput,
  DeliveryInspectResult,
  DeliveryPickData,
  DeliveryPickResult,
  DeliveryPendingWorkInput,
  DeliveryPendingWorkResult,
  DeliveryPreparePickInput,
  DeliveryPromoteAndPushData,
  DeliveryPromoteAndPushInput,
  DeliveryPromoteAndPushResult,
  DeliveryRepositoryInfo,
  DeliveryRestoreMainData,
  DeliveryRestoreMainInput,
  DeliveryRestoreMainResult,
  DeliveryResult,
  DeliverySourceInfo,
  DeliverySyncWorktreesData,
  DeliverySyncWorktreesInput,
  DeliverySyncWorktreesResult,
  DeliveryUndoData,
  DeliveryUndoInput,
  DeliveryUndoResult,
  DeliveryWorktreeSyncResult,
} from './deliveryTypes.js'

export type Log = ((msg: string) => void) | undefined

const DEFAULT_TEMP_DIR = '.universe-editor-delivery-worktrees'
export const NETWORK_TIMEOUT_MS = 120_000
export const LOCAL_TIMEOUT_MS = 60_000
const SUBMODULE_TIMEOUT_MS = 300_000

/** Never let git open an editor, prompt for credentials, or wait for a password. */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
}

export interface DeliveryGitOptions {
  readonly input?: string
  readonly timeoutMs?: number
}

export function runDeliveryGit(
  args: readonly string[],
  cwd: string,
  log?: Log,
  options?: DeliveryGitOptions,
): Promise<GitExecResult> {
  return gitExec(args, cwd, log, { env: NON_INTERACTIVE_ENV, ...options })
}

const failure = (code: DeliveryErrorCode, message: string, detail?: string): DeliveryFailure => ({
  code,
  message,
  ...(detail !== undefined ? { detail } : {}),
})

const fail = <T>(code: DeliveryErrorCode, message: string, detail?: string): DeliveryResult<T> => ({
  ok: false,
  error: failure(code, message, detail),
})

const okData = <T extends object>(data: T): DeliveryResult<T> => ({ ok: true, ...data })

const gitFail = <T>(message: string, res: GitExecResult): DeliveryResult<T> =>
  fail('git_failed', message, gitErrorText(res))

export const currentHead = async (cwd: string, log?: Log): Promise<string | undefined> => {
  const res = await runDeliveryGit(['rev-parse', 'HEAD'], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined
}

export const currentBranch = async (cwd: string, log?: Log): Promise<string | undefined> => {
  const res = await runDeliveryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined
}

/** Rejects when the main worktree no longer has `branch` checked out. */
const requireMainBranch = async (
  mainWorktree: string,
  branch: string,
  log?: Log,
): Promise<DeliveryFailure | undefined> => {
  const actual = await currentBranch(mainWorktree, log)
  if (actual === branch) return undefined
  return failure(
    'target_branch_mismatch',
    `The main worktree is on '${actual ?? 'detached HEAD'}', not '${branch}'.`,
  )
}

export const resolveRef = async (
  cwd: string,
  ref: string,
  log?: Log,
): Promise<string | undefined> => {
  const res = await runDeliveryGit(['rev-parse', '--verify', '-q', ref], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined
}

export const isAncestor = async (
  cwd: string,
  ancestor: string,
  descendant: string,
  log?: Log,
): Promise<boolean | undefined> => {
  const res = await runDeliveryGit(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    cwd,
    log,
    { timeoutMs: LOCAL_TIMEOUT_MS },
  )
  if (res.exitCode === 0) return true
  if (res.exitCode === 1) return false
  return undefined
}

interface Divergence {
  readonly ahead: number
  readonly behind: number
}

export const divergence = async (
  cwd: string,
  local: string,
  remote: string,
  log?: Log,
): Promise<Divergence | undefined> => {
  const res = await runDeliveryGit(
    ['rev-list', '--count', '--left-right', `${local}...${remote}`],
    cwd,
    log,
    { timeoutMs: LOCAL_TIMEOUT_MS },
  )
  if (res.exitCode !== 0) return undefined
  const [left, right] = res.stdout.trim().split(/\s+/)
  const ahead = Number(left)
  const behind = Number(right)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined
  return { ahead, behind }
}

/**
 * Shared by inspect and the mobile availability probe so both agree on which
 * commits count as "to deliver": when main can fast-forward to upstream, commits
 * already on the upstream are not pending.
 */
export const deliveryBaseSha = (
  mainHead: string,
  upstreamHead: string,
  mainIsBehindUpstream: boolean,
): string => (mainIsBehindUpstream ? upstreamHead : mainHead)

export const listWorktrees = async (
  cwd: string,
  log?: Log,
): Promise<WorktreeInfo[] | undefined> => {
  const res = await runDeliveryGit(['worktree', 'list', '--porcelain'], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (res.exitCode !== 0) return undefined
  return parseWorktrees(res.stdout)
}

export async function readWorktreeStatus(cwd: string, log?: Log): Promise<GitStatus | undefined> {
  const res = await runDeliveryGit(['status', '--porcelain=v2', '--branch', '-z'], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (res.exitCode !== 0) return undefined
  return parseStatus(res.stdout)
}

const describeCommit = async (
  cwd: string,
  sha: string,
  log?: Log,
): Promise<DeliveryCommitInfo | undefined> => {
  const res = await runDeliveryGit(
    ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', sha],
    cwd,
    log,
    { timeoutMs: LOCAL_TIMEOUT_MS },
  )
  if (res.exitCode !== 0) return undefined
  const [fullSha, shortSha, subject, author, authoredAt] = res.stdout.trimEnd().split('\x1f')
  if (!fullSha) return undefined
  return {
    sha: fullSha,
    shortSha: shortSha ?? '',
    subject: subject ?? '',
    author: author ?? '',
    authoredAt: authoredAt ?? '',
  }
}

const commitsInRange = async (
  cwd: string,
  range: string,
  log?: Log,
): Promise<DeliveryCommitInfo[] | undefined> => {
  const res = await runDeliveryGit(
    ['log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', range],
    cwd,
    log,
    { timeoutMs: LOCAL_TIMEOUT_MS },
  )
  if (res.exitCode !== 0) return undefined
  const commits: DeliveryCommitInfo[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const [sha, shortSha, subject, author, authoredAt] = line.split('\x1f')
    if (!sha) continue
    commits.push({
      sha,
      shortSha: shortSha ?? '',
      subject: subject ?? '',
      author: author ?? '',
      authoredAt: authoredAt ?? '',
    })
  }
  return commits
}

const mergeCommitsInRange = async (
  cwd: string,
  range: string,
  log?: Log,
): Promise<string[] | undefined> => {
  const res = await runDeliveryGit(['rev-list', '--min-parents=2', range], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (res.exitCode !== 0) return undefined
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const countCommitsInRange = async (
  cwd: string,
  range: string,
  log?: Log,
): Promise<number | undefined> => {
  const res = await runDeliveryGit(['rev-list', '--count', range], cwd, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (res.exitCode !== 0) return undefined
  const count = Number(res.stdout.trim())
  return Number.isFinite(count) ? count : undefined
}

interface UpstreamInfo {
  readonly remote: string
  readonly remoteBranch: string
  readonly upstreamRef: string
}

export const resolveUpstream = async (
  mainWorktree: string,
  branch: string,
  log?: Log,
): Promise<UpstreamInfo | undefined> => {
  const res = await runDeliveryGit(
    [
      'for-each-ref',
      '--format=%(upstream:remotename) %(upstream:remoteref)',
      `refs/heads/${branch}`,
    ],
    mainWorktree,
    log,
    { timeoutMs: LOCAL_TIMEOUT_MS },
  )
  if (res.exitCode !== 0) return undefined
  const line = res.stdout.trim()
  const separator = line.indexOf(' ')
  if (separator <= 0) return undefined
  const remote = line.slice(0, separator)
  const ref = line.slice(separator + 1).trim()
  if (!remote || !ref) return undefined
  const remoteBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
  return { remote, remoteBranch, upstreamRef: `${remote}/${remoteBranch}` }
}

export const fetchRemote = (
  mainWorktree: string,
  remote: string,
  log?: Log,
): Promise<GitExecResult> =>
  runDeliveryGit(['fetch', remote, '--prune'], mainWorktree, log, {
    timeoutMs: NETWORK_TIMEOUT_MS,
  })

const updateSubmodulesAt = async (path: string, log?: Log): Promise<GitExecResult | undefined> => {
  if (!(await hasSubmodules(path))) return undefined
  return runDeliveryGit(['submodule', 'update', '--init', '--recursive'], path, log, {
    timeoutMs: SUBMODULE_TIMEOUT_MS,
  })
}

const resetHard = async (path: string, sha: string, log?: Log): Promise<GitExecResult> => {
  const reset = await runDeliveryGit(['reset', '--hard', sha], path, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (reset.exitCode !== 0) return reset
  const sub = await updateSubmodulesAt(path, log)
  if (sub !== undefined && sub.exitCode !== 0) return sub
  return reset
}

const isRegisteredWorktree = async (
  mainWorktree: string,
  path: string,
  log?: Log,
): Promise<boolean> => {
  const worktrees = await listWorktrees(mainWorktree, log)
  return worktrees?.some((wt) => samePath(wt.path, path)) ?? false
}

const removeTempWorktree = async (
  mainWorktree: string,
  tempPath: string,
  log?: Log,
): Promise<boolean> => {
  const res = await runDeliveryGit(['worktree', 'remove', '--force', tempPath], mainWorktree, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  await runDeliveryGit(['worktree', 'prune'], mainWorktree, log, { timeoutMs: LOCAL_TIMEOUT_MS })
  if (res.exitCode === 0) return true
  try {
    await stat(tempPath)
    return false
  } catch {
    return true
  }
}

const unmergedPaths = async (cwd: string, log?: Log): Promise<string[]> => {
  const status = await readWorktreeStatus(cwd, log)
  if (status === undefined) return []
  return status.files.filter((file) => file.kind === 'unmerged').map((file) => file.path)
}

const MAX_MARKER_SCAN_BYTES = 2 * 1024 * 1024
const CONFLICT_MARKER = /(?:^|\n)(?:<{7}|>{7})(?: |\n|$)/

/**
 * The resolver agent must leave no conflict markers behind. Scanning is capped
 * and non-fatal for binary/unreadable files; the unmerged-path check still
 * guards those. Unmerged entries are scanned on purpose: the agent edits the
 * working-tree file but leaves the index untouched for the editor to stage.
 */
const filesWithConflictMarkers = async (
  root: string,
  files: GitStatus['files'],
  _log?: Log,
): Promise<string[]> => {
  const marked: string[] = []
  for (const file of files) {
    if (file.workingTree === 'D') continue
    const full = join(root, file.path)
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_MARKER_SCAN_BYTES) continue
      const text = await readFile(full, 'utf8')
      if (CONFLICT_MARKER.test(text)) marked.push(file.path)
    } catch {
      // Unreadable or vanished file: nothing to scan.
    }
  }
  return marked
}

const isEmptyPick = async (cwd: string, log?: Log): Promise<boolean> => {
  const status = await readWorktreeStatus(cwd, log)
  if (status === undefined || status.files.length > 0) return false
  const cherryPickHead = await resolveRef(cwd, 'CHERRY_PICK_HEAD', log)
  return cherryPickHead !== undefined
}

const deliveryIdFragment = (deliveryId: string): string => {
  const safe = deliveryId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8)
  return safe || 'delivery'
}

/** Shared by prepare and abort so failure cleanup can derive the same path. */
const tempWorktreePath = (mainWorktree: string, deliveryId: string, tempRoot?: string): string => {
  const fragment = deliveryIdFragment(deliveryId)
  return tempRoot
    ? join(tempRoot, fragment)
    : join(dirname(mainWorktree), DEFAULT_TEMP_DIR, fragment)
}

/**
 * Cherry-pick `commits` in order. Empty picks are skipped and recorded; the
 * first conflict stops the loop and leaves the cherry-pick state in the temp
 * worktree for the conflict resolver.
 */
const pickCommits = async (
  tempWorktree: string,
  commits: readonly string[],
  picked: DeliveryCommitInfo[],
  skippedEmpty: string[],
  log?: Log,
): Promise<DeliveryPickResult> => {
  for (let index = 0; index < commits.length; index++) {
    const sha = commits[index]
    if (sha === undefined) continue
    const res = await runDeliveryGit(['cherry-pick', sha], tempWorktree, log, {
      timeoutMs: LOCAL_TIMEOUT_MS,
    })
    if (res.exitCode === 0) {
      const newHead = await currentHead(tempWorktree, log)
      const info =
        newHead !== undefined ? await describeCommit(tempWorktree, newHead, log) : undefined
      if (info !== undefined) picked.push(info)
      continue
    }

    const conflicts = await unmergedPaths(tempWorktree, log)
    if (conflicts.length > 0) {
      const tempHead = await currentHead(tempWorktree, log)
      if (tempHead === undefined) {
        return gitFail('Could not read the temporary worktree HEAD.', res)
      }
      const conflicted = await describeCommit(tempWorktree, sha, log)
      const data: DeliveryPickData = {
        status: 'conflict',
        tempWorktree,
        tempHead,
        picked,
        skippedEmpty,
        remainingCommits: commits.slice(index),
        conflictFiles: conflicts,
        ...(conflicted !== undefined ? { conflictedCommit: conflicted } : {}),
      }
      return okData(data)
    }

    if (await isEmptyPick(tempWorktree, log)) {
      const skip = await runDeliveryGit(['cherry-pick', '--skip'], tempWorktree, log, {
        timeoutMs: LOCAL_TIMEOUT_MS,
      })
      if (skip.exitCode !== 0) {
        return gitFail('Could not skip an empty cherry-pick.', skip)
      }
      skippedEmpty.push(sha)
      continue
    }

    await runDeliveryGit(['cherry-pick', '--abort'], tempWorktree, log, {
      timeoutMs: LOCAL_TIMEOUT_MS,
    })
    return gitFail(`Cherry-pick ${sha.slice(0, 8)} failed.`, res)
  }

  const tempHead = await currentHead(tempWorktree, log)
  if (tempHead === undefined) {
    return fail('git_failed', 'Could not read the temporary worktree HEAD.')
  }
  const data: DeliveryPickData = {
    status: 'picked',
    tempWorktree,
    tempHead,
    picked,
    skippedEmpty,
    remainingCommits: [],
    conflictFiles: [],
  }
  return okData(data)
}

export async function inspectDelivery(
  input: DeliveryInspectInput,
  log?: Log,
): Promise<DeliveryInspectResult> {
  if (typeof input?.sourceCwd !== 'string' || input.sourceCwd.length === 0) {
    return fail('not_a_repository', 'The session has no working directory.')
  }
  const dirs = await detectGitDirs(input.sourceCwd, log)
  const sourceWorktree = await detectRepoRoot(input.sourceCwd)
  if (dirs === undefined || sourceWorktree === undefined) {
    return fail('not_a_repository', 'The session working directory is not inside a git repository.')
  }

  const worktrees = await listWorktrees(input.sourceCwd, log)
  if (worktrees === undefined) return fail('git_failed', 'Could not list git worktrees.')
  const main = worktrees.find((wt) => wt.isMain)
  if (main === undefined) return fail('no_main_worktree', 'No main worktree was found.')
  if (main.bare) return fail('bare_repository', 'The main worktree is bare.')
  if (main.branch === undefined) {
    return fail('detached_main', 'The main worktree is in detached HEAD state.')
  }
  const targetBranch = input.targetBranch ?? main.branch
  if (targetBranch !== main.branch) {
    return fail(
      'target_branch_mismatch',
      `The main worktree is on '${main.branch}', not '${targetBranch}'.`,
    )
  }

  const upstream = await resolveUpstream(main.path, targetBranch, log)
  if (upstream === undefined) {
    return fail(
      'no_upstream',
      `Branch '${targetBranch}' has no upstream. Set one before delivering.`,
    )
  }
  if (input.fetch !== false) {
    const fetched = await fetchRemote(main.path, upstream.remote, log)
    if (fetched.exitCode !== 0) {
      return fail('fetch_failed', `Fetching '${upstream.remote}' failed.`, gitErrorText(fetched))
    }
  }

  const mainHead = await currentHead(main.path, log)
  if (mainHead === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')
  const upstreamHead = await resolveRef(main.path, upstream.upstreamRef, log)
  if (upstreamHead === undefined) {
    return fail(
      'no_upstream',
      `Upstream ref '${upstream.upstreamRef}' does not exist. Fetch before delivering.`,
    )
  }
  const counts = await divergence(main.path, mainHead, upstreamHead, log)
  if (counts === undefined) return fail('git_failed', 'Could not compare main with its upstream.')

  const mainStatus = await readWorktreeStatus(main.path, log)
  if (mainStatus === undefined) return fail('git_failed', 'Could not read git status for main.')
  const mainPending = await pendingOperation(main.path, log)

  const sourceHead = await currentHead(sourceWorktree, log)
  if (sourceHead === undefined)
    return fail('source_missing', 'Could not read the source worktree HEAD.')
  const sourceStatus = await readWorktreeStatus(sourceWorktree, log)
  if (sourceStatus === undefined) {
    return fail('git_failed', 'Could not read git status for the source worktree.')
  }
  const sourcePending = await pendingOperation(sourceWorktree, log)
  const dirty = sourceStatus.files.length > 0

  const canFastForward = counts.ahead === 0 && counts.behind > 0
  const baseSha = deliveryBaseSha(mainHead, upstreamHead, canFastForward)
  const range = `${baseSha}..${sourceHead}`
  const commits = await commitsInRange(sourceWorktree, range, log)
  if (commits === undefined) return fail('git_failed', 'Could not list the commits to deliver.')
  const merges = await mergeCommitsInRange(sourceWorktree, range, log)
  if (merges === undefined) return fail('git_failed', 'Could not inspect the commits to deliver.')

  const blockers: DeliveryFailure[] = []
  if (counts.ahead > 0 && counts.behind > 0) {
    blockers.push(
      failure(
        'main_diverged',
        'The main branch has diverged from its upstream. Reconcile it before delivering.',
      ),
    )
  }
  if (mainStatus.files.length > 0) {
    blockers.push(failure('main_dirty', 'The main worktree has uncommitted changes.'))
  }
  if (mainPending !== undefined) {
    blockers.push(
      failure('main_in_progress', `The main worktree has a ${mainPending} in progress.`),
    )
  }
  if (sourcePending !== undefined) {
    blockers.push(
      failure('source_in_progress', `The source worktree has a ${sourcePending} in progress.`),
    )
  }
  if (merges.length > 0) {
    blockers.push(
      failure(
        'merge_commit_unsupported',
        `Merge commits cannot be delivered yet (${merges.length} found).`,
      ),
    )
  }
  if (!dirty && commits.length === 0) {
    blockers.push(failure('nothing_to_deliver', 'The source worktree has nothing to deliver.'))
  }

  const warnings: string[] = []
  if (counts.ahead > 0) {
    warnings.push(
      `The main branch has ${counts.ahead} unpushed commit(s); pushing will publish them too.`,
    )
  }
  if (dirty) {
    warnings.push(
      'The source worktree has uncommitted changes; the agent will generate a commit message first.',
    )
  }
  if (sourceStatus.branch === undefined) {
    warnings.push('The source worktree is detached; it will be reset to main after delivery.')
  }

  const repository: DeliveryRepositoryInfo = {
    commonDir: dirs.commonDir,
    mainWorktree: main.path,
    mainBranch: main.branch,
    targetBranch,
    remote: upstream.remote,
    remoteBranch: upstream.remoteBranch,
    upstreamRef: upstream.upstreamRef,
    mainHead,
    upstreamHead,
    aheadOfUpstream: counts.ahead,
    behindUpstream: counts.behind,
    canFastForward,
  }
  const source: DeliverySourceInfo = {
    worktree: sourceWorktree,
    ...(sourceStatus.branch !== undefined ? { branch: sourceStatus.branch } : {}),
    head: sourceHead,
    dirty,
    changedFileCount: sourceStatus.files.length,
    untrackedCount: sourceStatus.files.filter((file) => file.kind === 'untracked').length,
    ...(sourcePending !== undefined ? { pendingOperation: sourcePending } : {}),
    isMainWorktree: samePath(main.path, sourceWorktree),
  }
  const data: DeliveryInspectData = {
    repository,
    source,
    commits,
    baseSha,
    blockers,
    warnings,
  }
  return okData(data)
}

/** Mirrors inspect's baseSha without fetching; an unresolved upstream falls back to main. */
const pendingBaseSha = async (
  mainWorktree: string,
  mainBranch: string,
  mainHead: string,
  log?: Log,
): Promise<string> => {
  const upstream = await resolveUpstream(mainWorktree, mainBranch, log)
  if (upstream === undefined) return mainHead
  const upstreamHead = await resolveRef(mainWorktree, upstream.upstreamRef, log)
  if (upstreamHead === undefined || upstreamHead === mainHead) return mainHead
  const behind = await isAncestor(mainWorktree, mainHead, upstreamHead, log)
  return behind === true ? upstreamHead : mainHead
}

/**
 * Cheap probe for the mobile inbox's「交付」action: only report a delivery when
 * the source worktree is dirty or still holds commits main does not reach.
 * Unlike inspect this never fetches and does not require delivery to be
 * unblocked — the confirm sheet owns the detailed blockers.
 */
export async function hasPendingWork(
  input: DeliveryPendingWorkInput,
  log?: Log,
): Promise<DeliveryPendingWorkResult> {
  if (typeof input?.sourceCwd !== 'string' || input.sourceCwd.length === 0) {
    return fail('not_a_repository', 'The session has no working directory.')
  }
  const sourceWorktree = await detectRepoRoot(input.sourceCwd)
  if (sourceWorktree === undefined) {
    return fail('not_a_repository', 'The session working directory is not inside a git repository.')
  }
  const sourceStatus = await readWorktreeStatus(sourceWorktree, log)
  if (sourceStatus === undefined) {
    return fail('git_failed', 'Could not read git status for the source worktree.')
  }
  const dirty = sourceStatus.files.length > 0
  if (dirty) return okData({ pending: true, dirty: true, commitCount: 0 })

  const sourceHead = sourceStatus.headRevision ?? (await currentHead(sourceWorktree, log))
  if (sourceHead === undefined) return okData({ pending: false, dirty: false, commitCount: 0 })

  const worktrees = await listWorktrees(input.sourceCwd, log)
  if (worktrees === undefined) return fail('git_failed', 'Could not list git worktrees.')
  const main = worktrees.find((wt) => wt.isMain)
  if (main === undefined) return fail('no_main_worktree', 'No main worktree was found.')
  if (main.bare) return fail('bare_repository', 'The main worktree is bare.')
  if (main.branch === undefined) {
    return fail('detached_main', 'The main worktree is in detached HEAD state.')
  }
  const mainHead = await currentHead(main.path, log)
  if (mainHead === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')

  // The common "nothing to deliver" case stops here without resolving upstream.
  const againstMain = await countCommitsInRange(sourceWorktree, `${mainHead}..${sourceHead}`, log)
  if (againstMain === undefined) return fail('git_failed', 'Could not count pending commits.')
  if (againstMain === 0) return okData({ pending: false, dirty: false, commitCount: 0 })

  const baseSha = await pendingBaseSha(main.path, main.branch, mainHead, log)
  const commitCount =
    baseSha === mainHead
      ? againstMain
      : await countCommitsInRange(sourceWorktree, `${baseSha}..${sourceHead}`, log)
  if (commitCount === undefined) return fail('git_failed', 'Could not count pending commits.')
  return okData({ pending: commitCount > 0, dirty: false, commitCount })
}

export async function beginDelivery(
  input: DeliveryBeginInput,
  log?: Log,
): Promise<DeliveryBeginResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }

  const mainHeadBefore = await currentHead(input.mainWorktree, log)
  if (mainHeadBefore === undefined)
    return fail('git_failed', 'Could not read the main worktree HEAD.')
  const branchError = await requireMainBranch(input.mainWorktree, input.targetBranch, log)
  if (branchError !== undefined) return fail(branchError.code, branchError.message)
  if (mainHeadBefore !== input.expectedMainHead) {
    return fail('main_moved', 'The main branch moved since the preview. Refresh and try again.')
  }
  const sourceHead = await currentHead(input.sourceCwd, log)
  if (sourceHead === undefined)
    return fail('source_missing', 'Could not read the source worktree HEAD.')
  if (sourceHead !== input.expectedSourceHead) {
    return fail(
      'head_mismatch',
      'The source worktree moved since the preview. Refresh and try again.',
    )
  }

  const mainStatus = await readWorktreeStatus(input.mainWorktree, log)
  if (mainStatus === undefined) return fail('git_failed', 'Could not read git status for main.')
  if (mainStatus.files.length > 0) {
    return fail('main_dirty', 'The main worktree has uncommitted changes.')
  }
  const mainPending = await pendingOperation(input.mainWorktree, log)
  if (mainPending !== undefined) {
    return fail('main_in_progress', `The main worktree has a ${mainPending} in progress.`)
  }

  const upstream = await resolveUpstream(input.mainWorktree, input.targetBranch, log)
  if (upstream === undefined) {
    return fail('no_upstream', `Branch '${input.targetBranch}' has no upstream.`)
  }
  if (upstream.remote !== input.remote || upstream.upstreamRef !== input.upstreamRef) {
    return fail('upstream_changed', 'The upstream configuration changed since the preview.')
  }

  const fetched = await fetchRemote(input.mainWorktree, upstream.remote, log)
  if (fetched.exitCode !== 0) {
    return fail('fetch_failed', `Fetching '${upstream.remote}' failed.`, gitErrorText(fetched))
  }
  const upstreamHead = await resolveRef(input.mainWorktree, upstream.upstreamRef, log)
  if (upstreamHead === undefined) {
    return fail('no_upstream', `Upstream ref '${upstream.upstreamRef}' does not exist.`)
  }
  if (upstreamHead !== input.expectedUpstreamHead) {
    return fail(
      'main_moved',
      'The remote main branch moved since the preview. Refresh and try again.',
    )
  }

  let mainHeadAfter = mainHeadBefore
  if (mainHeadBefore !== upstreamHead) {
    const mainBehind = await isAncestor(input.mainWorktree, mainHeadBefore, upstreamHead, log)
    if (mainBehind === undefined) {
      return fail('git_failed', 'Could not compare main with its upstream.')
    }
    if (mainBehind) {
      const merge = await runDeliveryGit(
        ['merge', '--ff-only', upstream.upstreamRef],
        input.mainWorktree,
        log,
        { timeoutMs: NETWORK_TIMEOUT_MS },
      )
      if (merge.exitCode !== 0) {
        return fail('main_ff_failed', 'Fast-forwarding main failed.', gitErrorText(merge))
      }
      const updated = await currentHead(input.mainWorktree, log)
      if (updated === undefined || updated !== upstreamHead) {
        return fail('main_moved', 'Main did not fast-forward to the expected commit.')
      }
      mainHeadAfter = updated
    } else {
      const upstreamBehind = await isAncestor(input.mainWorktree, upstreamHead, mainHeadBefore, log)
      if (upstreamBehind === undefined) {
        return fail('git_failed', 'Could not compare main with its upstream.')
      }
      if (!upstreamBehind) {
        return fail(
          'main_diverged',
          'The main branch has diverged from its upstream. Reconcile it first.',
        )
      }
    }
  }

  const data: DeliveryBeginData = {
    mainHeadBefore,
    mainHeadAfter,
    upstreamHead,
    mainBranch: input.targetBranch,
    remote: upstream.remote,
    upstreamRef: upstream.upstreamRef,
    fetched: true,
  }
  return okData(data)
}

export async function commitSourceDelivery(
  input: DeliveryCommitSourceInput,
  log?: Log,
): Promise<DeliveryCommitSourceResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  const head = await currentHead(input.sourceWorktree, log)
  if (head === undefined) return fail('source_missing', 'Could not read the source worktree HEAD.')
  if (head !== input.expectedSourceHead) {
    return fail('head_mismatch', 'The source worktree moved before the commit was created.')
  }
  const message = input.message.trim()
  if (message.length === 0 || message.length > 4000) {
    return fail('invalid_message', 'The generated commit message is empty or too long.')
  }

  const status = await readWorktreeStatus(input.sourceWorktree, log)
  if (status === undefined) return fail('git_failed', 'Could not read git status.')
  if (status.files.length === 0) return fail('nothing_to_commit', 'The source worktree is clean.')

  const staged = await runDeliveryGit(['add', '-A'], input.sourceWorktree, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (staged.exitCode !== 0)
    return fail('git_failed', 'Staging changes failed.', gitErrorText(staged))

  const commit = await runDeliveryGit(['commit', '-m', message], input.sourceWorktree, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (commit.exitCode !== 0)
    return fail('git_failed', 'Committing the source changes failed.', gitErrorText(commit))

  const newHead = await currentHead(input.sourceWorktree, log)
  if (newHead === undefined || newHead === input.expectedSourceHead) {
    return fail('git_failed', 'The commit did not advance the source worktree HEAD.')
  }
  const info = await describeCommit(input.sourceWorktree, newHead, log)
  const data: DeliveryCommitSourceData = {
    head: newHead,
    commit: info ?? {
      sha: newHead,
      shortSha: newHead.slice(0, 8),
      subject: message.split('\n')[0] ?? '',
      author: '',
      authoredAt: new Date().toISOString(),
    },
  }
  return okData(data)
}

export async function preparePickDelivery(
  input: DeliveryPreparePickInput,
  log?: Log,
): Promise<DeliveryPickResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  const sourceHead = await currentHead(input.sourceWorktree, log)
  if (sourceHead === undefined)
    return fail('source_missing', 'Could not read the source worktree HEAD.')
  if (sourceHead !== input.sourceHead) {
    return fail('head_mismatch', 'The source worktree moved before the cherry-pick started.')
  }
  const baseExists = await resolveRef(input.mainWorktree, input.baseSha, log)
  if (baseExists === undefined)
    return fail('git_failed', 'The delivery base commit no longer exists.')

  const tempWorktree = tempWorktreePath(input.mainWorktree, input.deliveryId, input.tempRoot)

  if (await isRegisteredWorktree(input.mainWorktree, tempWorktree, log)) {
    await removeTempWorktree(input.mainWorktree, tempWorktree, log)
  }
  try {
    await stat(tempWorktree)
    return fail(
      'temp_worktree_failed',
      'The temporary delivery worktree path already exists and is not registered with git.',
      tempWorktree,
    )
  } catch {
    // expected: path must not exist
  }

  await mkdir(dirname(tempWorktree), { recursive: true })
  const add = await runDeliveryGit(
    ['worktree', 'add', '--detach', tempWorktree, input.baseSha],
    input.mainWorktree,
    log,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (add.exitCode !== 0) {
    return fail(
      'temp_worktree_failed',
      'Could not create the temporary worktree.',
      gitErrorText(add),
    )
  }

  // Submodules are intentionally left uninitialized: the temp worktree only
  // carries cherry-picked commits, and a linked worktree would clone every
  // submodule from its remote into `.git/worktrees/<id>/modules` (minutes per
  // delivery on a slow network).
  let result: DeliveryPickResult
  try {
    result = await pickCommits(tempWorktree, input.commits, [], [], log)
  } catch (err) {
    await removeTempWorktree(input.mainWorktree, tempWorktree, log)
    throw err
  }
  if (!result.ok) {
    await removeTempWorktree(input.mainWorktree, tempWorktree, log)
  }
  return result
}

export async function continuePickDelivery(
  input: DeliveryContinuePickInput,
  log?: Log,
): Promise<DeliveryPickResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  try {
    await stat(input.tempWorktree)
  } catch {
    return fail('temp_worktree_failed', 'The temporary worktree no longer exists.')
  }
  if (input.expectedTempHead !== undefined) {
    const head = await currentHead(input.tempWorktree, log)
    if (head !== input.expectedTempHead) {
      return fail('head_mismatch', 'The temporary worktree moved before the pick continued.')
    }
  }
  const status = await readWorktreeStatus(input.tempWorktree, log)
  if (status === undefined) return fail('git_failed', 'Could not read git status.')
  const allowed = new Set(input.conflictFiles)
  const outside = status.files.map((file) => file.path).filter((path) => !allowed.has(path))
  if (outside.length > 0) {
    return fail(
      'source_changed',
      'The resolver modified files outside the conflict set.',
      outside.join('\n'),
    )
  }
  const marked = await filesWithConflictMarkers(input.tempWorktree, status.files, log)
  if (marked.length > 0) {
    return fail('conflict', 'Conflict markers remain in the temporary worktree.', marked.join('\n'))
  }

  const staged = await runDeliveryGit(['add', '-A'], input.tempWorktree, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (staged.exitCode !== 0)
    return fail('git_failed', 'Staging resolved files failed.', gitErrorText(staged))
  // Staging the resolved files clears the unmerged index entries; anything left
  // means the resolver did not actually resolve every path.
  const unmerged = await unmergedPaths(input.tempWorktree, log)
  if (unmerged.length > 0) {
    return fail('conflict', 'Unmerged paths remain in the temporary worktree.', unmerged.join('\n'))
  }
  const continued = await runDeliveryGit(['cherry-pick', '--continue'], input.tempWorktree, log, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  })
  if (continued.exitCode !== 0) {
    const remainingConflicts = await unmergedPaths(input.tempWorktree, log)
    if (remainingConflicts.length > 0) {
      return fail(
        'conflict',
        'Cherry-pick still has conflicts after continuing.',
        remainingConflicts.join('\n'),
      )
    }
    return fail('git_failed', 'Continuing the cherry-pick failed.', gitErrorText(continued))
  }

  const picked: DeliveryCommitInfo[] = []
  const head = await currentHead(input.tempWorktree, log)
  if (head !== undefined) {
    const info = await describeCommit(input.tempWorktree, head, log)
    if (info !== undefined) picked.push(info)
  }
  const remaining = input.remainingCommits.slice(1)
  return pickCommits(input.tempWorktree, remaining, picked, [], log)
}

export async function abortPickDelivery(
  input: DeliveryAbortPickInput,
  log?: Log,
): Promise<DeliveryAbortPickResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  // Prepare can die before it reports the path (e.g. the extension host is
  // restarted mid-pick), so the caller may omit it and rely on the same
  // deterministic naming prepare uses.
  const tempWorktree = input.tempWorktree ?? tempWorktreePath(input.mainWorktree, input.deliveryId)
  if (await isRegisteredWorktree(input.mainWorktree, tempWorktree, log)) {
    await runDeliveryGit(['cherry-pick', '--abort'], tempWorktree, log, {
      timeoutMs: LOCAL_TIMEOUT_MS,
    })
    const removed = await removeTempWorktree(input.mainWorktree, tempWorktree, log)
    return okData({ removed })
  }
  return okData({ removed: true })
}

export async function promoteAndPushDelivery(
  input: DeliveryPromoteAndPushInput,
  log?: Log,
): Promise<DeliveryPromoteAndPushResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  const mainHead = await currentHead(input.mainWorktree, log)
  if (mainHead === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')
  const branchError = await requireMainBranch(input.mainWorktree, input.targetBranch, log)
  if (branchError !== undefined) return fail(branchError.code, branchError.message)
  if (mainHead !== input.baseSha && mainHead !== input.tempHead) {
    return fail(
      'main_moved',
      'The main branch moved while the delivery was waiting for confirmation.',
    )
  }
  const mainStatus = await readWorktreeStatus(input.mainWorktree, log)
  if (mainStatus === undefined) return fail('git_failed', 'Could not read git status for main.')
  if (mainStatus.files.length > 0) {
    return fail('main_dirty', 'The main worktree has uncommitted changes.')
  }
  const mainPending = await pendingOperation(input.mainWorktree, log)
  if (mainPending !== undefined) {
    return fail('main_in_progress', `The main worktree has a ${mainPending} in progress.`)
  }
  const tempHead = await currentHead(input.tempWorktree, log)
  if (tempHead === undefined)
    return fail('temp_worktree_failed', 'The temporary worktree is missing.')
  if (tempHead !== input.tempHead) {
    return fail('head_mismatch', 'The temporary worktree moved before push.')
  }
  const based = await isAncestor(input.tempWorktree, input.baseSha, input.tempHead, log)
  if (based !== true) {
    return fail('head_mismatch', 'The delivered commits do not sit on the expected main commit.')
  }

  if (mainHead !== input.tempHead) {
    const reset = await resetHard(input.mainWorktree, input.tempHead, log)
    if (reset.exitCode !== 0) {
      await resetHard(input.mainWorktree, input.baseSha, log)
      return fail('git_failed', 'Moving main to the delivered commits failed.', gitErrorText(reset))
    }
  }

  const remoteBranch = input.upstreamRef.startsWith(`${input.remote}/`)
    ? input.upstreamRef.slice(input.remote.length + 1)
    : undefined
  if (remoteBranch === undefined) {
    await resetHard(input.mainWorktree, input.baseSha, log)
    return fail('no_upstream', 'The upstream ref does not belong to the configured remote.')
  }
  const push = await runDeliveryGit(
    ['push', input.remote, `${input.targetBranch}:${remoteBranch}`],
    input.mainWorktree,
    log,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (push.exitCode !== 0) {
    const fetched = await fetchRemote(input.mainWorktree, input.remote, log)
    let remoteHasCommits = false
    if (fetched.exitCode === 0) {
      const remoteHead = await resolveRef(input.mainWorktree, input.upstreamRef, log)
      if (remoteHead !== undefined) {
        remoteHasCommits =
          remoteHead === input.tempHead ||
          (await isAncestor(input.mainWorktree, input.tempHead, remoteHead, log)) === true
      }
    }
    if (!remoteHasCommits) {
      const restored = await resetHard(input.mainWorktree, input.baseSha, log)
      const detail =
        restored.exitCode === 0
          ? gitErrorText(push)
          : `${gitErrorText(push)}\n${gitErrorText(restored)}`
      return fail('push_failed', 'Pushing the delivered commits failed.', detail)
    }
  }

  // Do not trust the push exit code alone: another process can move the target
  // branch back, and a refspec push reports success when it is already up to date.
  const verified = await fetchRemote(input.mainWorktree, input.remote, log)
  if (verified.exitCode !== 0) {
    return fail('push_failed', 'Could not verify the pushed commits.', gitErrorText(verified))
  }
  const pushedHead = await resolveRef(input.mainWorktree, input.upstreamRef, log)
  if (pushedHead !== input.tempHead) {
    return fail(
      'push_failed',
      'The remote branch does not point at the delivered commits.',
      `expected ${input.tempHead}, found ${pushedHead ?? 'none'}`,
    )
  }

  await removeTempWorktree(input.mainWorktree, input.tempWorktree, log)
  const data: DeliveryPromoteAndPushData = {
    pushedSha: input.tempHead,
    mainHead: input.tempHead,
    remoteRef: input.upstreamRef,
  }
  return okData(data)
}

export async function restoreMainDelivery(
  input: DeliveryRestoreMainInput,
  log?: Log,
): Promise<DeliveryRestoreMainResult> {
  const head = await currentHead(input.mainWorktree, log)
  if (head === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')
  if (input.targetBranch !== undefined) {
    const branchError = await requireMainBranch(input.mainWorktree, input.targetBranch, log)
    if (branchError !== undefined) return fail(branchError.code, branchError.message)
  }
  if (head !== input.expectedCurrentHead) {
    return fail('main_moved', 'Main moved; refusing to restore it automatically.')
  }
  const status = await readWorktreeStatus(input.mainWorktree, log)
  if (status === undefined) return fail('git_failed', 'Could not read git status for main.')
  if (status.files.length > 0) {
    return fail('main_dirty', 'The main worktree has uncommitted changes.')
  }
  const pending = await pendingOperation(input.mainWorktree, log)
  if (pending !== undefined) {
    return fail('main_in_progress', `The main worktree has a ${pending} in progress.`)
  }
  const restored = await resetHard(input.mainWorktree, input.restoreToHead, log)
  if (restored.exitCode !== 0) {
    return fail('git_failed', 'Restoring main failed.', gitErrorText(restored))
  }
  const data: DeliveryRestoreMainData = { head: input.restoreToHead }
  return okData(data)
}

const syncOutcome = async (
  worktree: WorktreeInfo,
  newHead: string,
  sourceWorktree: string,
  expectedSourceHead: string,
  log?: Log,
): Promise<DeliveryWorktreeSyncResult> => {
  const name = basename(worktree.path)
  const branchField = worktree.branch !== undefined ? { branch: worktree.branch } : {}
  const isSource = samePath(worktree.path, sourceWorktree)

  const head = await currentHead(worktree.path, log)
  if (head === undefined) {
    return {
      name,
      path: worktree.path,
      ...branchField,
      status: 'failed',
      error: 'Could not read HEAD.',
    }
  }
  if (head === newHead) {
    return { name, path: worktree.path, ...branchField, status: 'up_to_date' }
  }
  if (isSource && head !== expectedSourceHead) {
    return {
      name,
      path: worktree.path,
      ...branchField,
      status: 'skipped_source_changed',
      error: 'The source worktree moved after delivery started.',
    }
  }

  const status = await readWorktreeStatus(worktree.path, log)
  if (status === undefined) {
    return {
      name,
      path: worktree.path,
      ...branchField,
      status: 'failed',
      error: 'Could not read git status.',
    }
  }
  if (status.files.length > 0) {
    return { name, path: worktree.path, ...branchField, status: 'skipped_dirty' }
  }
  const pending = await pendingOperation(worktree.path, log)
  if (pending !== undefined) {
    return {
      name,
      path: worktree.path,
      ...branchField,
      status: 'skipped_in_progress',
      error: pending,
    }
  }
  // The source worktree is reset by contract: its commits were just cherry-picked
  // onto main, so its HEAD is not an ancestor of newHead. Every other worktree
  // must fast-forward or stay put.
  if (!isSource) {
    const ancestor = await isAncestor(worktree.path, head, newHead, log)
    if (ancestor === undefined) {
      return {
        name,
        path: worktree.path,
        ...branchField,
        status: 'failed',
        error: 'Ancestry check failed.',
      }
    }
    if (!ancestor) {
      return {
        name,
        path: worktree.path,
        ...branchField,
        status: 'skipped_diverged',
        error: 'The worktree has commits of its own.',
      }
    }
  }

  const reset = await resetHard(worktree.path, newHead, log)
  if (reset.exitCode !== 0) {
    return {
      name,
      path: worktree.path,
      ...branchField,
      status: 'failed',
      error: gitErrorText(reset),
    }
  }
  return { name, path: worktree.path, ...branchField, status: 'synced' }
}

export async function syncWorktreesDelivery(
  input: DeliverySyncWorktreesInput,
  log?: Log,
): Promise<DeliverySyncWorktreesResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  const worktrees = await listWorktrees(input.mainWorktree, log)
  if (worktrees === undefined) return fail('git_failed', 'Could not list git worktrees.')

  const candidates = worktrees.filter(
    (wt) =>
      !wt.bare && (input.tempWorktree === undefined || !samePath(wt.path, input.tempWorktree)),
  )
  const results = await Promise.all(
    candidates.map(async (wt) => {
      try {
        return await syncOutcome(
          wt,
          input.newHead,
          input.sourceWorktree,
          input.expectedSourceHead,
          log,
        )
      } catch (err) {
        return {
          name: basename(wt.path),
          path: wt.path,
          ...(wt.branch !== undefined ? { branch: wt.branch } : {}),
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
  const data: DeliverySyncWorktreesData = { results }
  return okData(data)
}

export async function undeliverDelivery(
  input: DeliveryUndoInput,
  log?: Log,
): Promise<DeliveryUndoResult> {
  if (!(await isDeliveryLockHeld(input.commonDir, input.token))) {
    return fail('lock_lost', 'The delivery lock is no longer held by this session.')
  }
  const head = await currentHead(input.mainWorktree, log)
  if (head === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')
  const branchError = await requireMainBranch(input.mainWorktree, input.targetBranch, log)
  if (branchError !== undefined) return fail(branchError.code, branchError.message)
  if (head !== input.pushedSha) {
    return fail('main_moved', 'Main moved since the delivery was pushed; undo is not safe.')
  }
  const status = await readWorktreeStatus(input.mainWorktree, log)
  if (status === undefined) return fail('git_failed', 'Could not read git status for main.')
  if (status.files.length > 0) {
    return fail('main_dirty', 'The main worktree has uncommitted changes.')
  }
  const pending = await pendingOperation(input.mainWorktree, log)
  if (pending !== undefined) {
    return fail('main_in_progress', `The main worktree has a ${pending} in progress.`)
  }

  const fetched = await fetchRemote(input.mainWorktree, input.remote, log)
  if (fetched.exitCode !== 0) {
    return fail('fetch_failed', `Fetching '${input.remote}' failed.`, gitErrorText(fetched))
  }
  const remoteHead = await resolveRef(input.mainWorktree, input.upstreamRef, log)
  if (remoteHead === undefined) {
    return fail('no_upstream', `Upstream ref '${input.upstreamRef}' does not exist.`)
  }
  if (remoteHead !== input.pushedSha) {
    return fail('remote_moved', 'The remote branch moved since the delivery was pushed.')
  }

  const reverted: string[] = []
  for (const sha of [...input.deliveredShas].reverse()) {
    const res = await runDeliveryGit(['revert', '--no-edit', sha], input.mainWorktree, log, {
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    if (res.exitCode !== 0) {
      const conflicts = await unmergedPaths(input.mainWorktree, log)
      await runDeliveryGit(['revert', '--abort'], input.mainWorktree, log, {
        timeoutMs: LOCAL_TIMEOUT_MS,
      })
      return fail(
        'conflict',
        `Reverting ${sha.slice(0, 8)} failed.`,
        conflicts.length > 0 ? conflicts.join('\n') : gitErrorText(res),
      )
    }
    reverted.push(sha)
  }

  const remoteBranch = input.upstreamRef.startsWith(`${input.remote}/`)
    ? input.upstreamRef.slice(input.remote.length + 1)
    : undefined
  if (remoteBranch === undefined) {
    return fail('no_upstream', 'The upstream ref does not belong to the configured remote.')
  }
  const push = await runDeliveryGit(
    ['push', input.remote, `${input.targetBranch}:${remoteBranch}`],
    input.mainWorktree,
    log,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (push.exitCode !== 0) {
    const restored = await resetHard(input.mainWorktree, input.pushedSha, log)
    const detail =
      restored.exitCode === 0
        ? gitErrorText(push)
        : `${gitErrorText(push)}\n${gitErrorText(restored)}`
    return fail('push_failed', 'Pushing the revert commits failed.', detail)
  }

  const newHead = await currentHead(input.mainWorktree, log)
  if (newHead === undefined) return fail('git_failed', 'Could not read the main worktree HEAD.')
  const verified = await fetchRemote(input.mainWorktree, input.remote, log)
  if (verified.exitCode !== 0) {
    return fail(
      'push_failed',
      'Could not verify the pushed revert commits.',
      gitErrorText(verified),
    )
  }
  const pushedHead = await resolveRef(input.mainWorktree, input.upstreamRef, log)
  if (pushedHead !== newHead) {
    return fail(
      'push_failed',
      'The remote branch does not point at the revert commits.',
      `expected ${newHead}, found ${pushedHead ?? 'none'}`,
    )
  }
  const data: DeliveryUndoData = {
    mainHead: newHead,
    revertedShas: reverted,
    remoteRef: input.upstreamRef,
  }
  return okData(data)
}
