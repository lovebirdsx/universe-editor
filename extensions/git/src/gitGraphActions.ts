/**
 * Git Graph mutating operations. Each helper targets an explicit object the user
 * right-clicked (a commit hash, branch, tag…) — unlike `repository.ts`, which
 * prompts interactively. Every call is a thin `gitExec` wrapper returning the
 * full result (stdout/stderr/exitCode); the caller in `extension.ts` surfaces
 * errors — stderr included — and refreshes.
 *
 * Read-only queries live in `gitGraphSource.ts`; this file only writes.
 */
import { basename } from 'node:path'
import { gitExec, type GitExecResult } from './gitService.js'
import { gitErrorText } from './gitError.js'
import { parseWorktrees, type WorktreeInfo } from './worktreeParser.js'
import { samePath } from './pathUtil.js'
import { updateSubmodules } from './submoduleSync.js'

export type ResetMode = 'soft' | 'mixed' | 'hard'

type Log = ((msg: string) => void) | undefined

/**
 * A mutation's result, plus where it actually ran. Some operations are redirected
 * into another worktree's directory (git refuses to check out a branch a linked
 * worktree already holds), and the caller reports that so the change doesn't land
 * somewhere the user can't see.
 */
export interface GraphMutationResult extends GitExecResult {
  readonly worktreePath?: string
  readonly worktreeName?: string
}

/** Tag a result with the worktree it ran in, for the caller to surface. */
const inWorktree = (res: GitExecResult, path: string): GraphMutationResult => ({
  ...res,
  worktreePath: path,
  worktreeName: basename(path),
})

export const checkout = (root: string, ref: string, log: Log): Promise<GitExecResult> =>
  gitExec(['checkout', ref], root, log)

export const cherrypick = (root: string, hash: string, log: Log): Promise<GitExecResult> =>
  gitExec(['cherry-pick', hash], root, log)

/** Synthesize a failed GitExecResult so callers surface a message via the normal path. */
const failure = (message: string): GitExecResult => ({ stdout: '', stderr: message, exitCode: 1 })

/** The worktree holding `branch`, or undefined when none lists it (or listing fails). */
const findBranchHolder = async (
  root: string,
  branch: string,
  log: Log,
): Promise<WorktreeInfo | undefined> => {
  const wtRes = await gitExec(['worktree', 'list', '--porcelain'], root, log)
  if (wtRes.exitCode !== 0) return undefined
  return parseWorktrees(wtRes.stdout).find((wt) => wt.branch === branch)
}

/**
 * Cherry-pick `hash` onto `targetBranch`.
 *
 * A branch checked out by another worktree (the classic case: `main` held by the
 * main working tree while you work in a linked one) can't be checked out here —
 * git rejects it with "'<branch>' is already used by worktree at …". So when the
 * target is checked out somewhere, we cherry-pick *inside that worktree's own
 * directory* instead: its HEAD advances there and this working tree never moves.
 * That worktree must be clean, or the pick would apply on top of pending edits —
 * we refuse with a clear message rather than leave a half-applied state.
 *
 * Otherwise (the target isn't checked out anywhere) we check it out here,
 * cherry-pick, then restore the original HEAD (branch name or detached SHA). A
 * clean pick leaves the caller exactly where they started, only with the target
 * advanced; a conflict leaves HEAD on the target so it can be resolved or aborted.
 */
export const cherryPickToBranch = async (
  root: string,
  hash: string,
  targetBranch: string,
  log: Log,
): Promise<GraphMutationResult> => {
  const holder = await findBranchHolder(root, targetBranch, log)

  if (holder) {
    // Picking into the current worktree needs no checkout; into another one, run
    // it there so this tree stays put. Either way, guard against a dirty tree.
    const isCurrent = samePath(holder.path, root)
    const status = await gitExec(['status', '--porcelain'], holder.path, log)
    if (status.exitCode !== 0) return status
    if (status.stdout.trim()) {
      return failure(
        isCurrent
          ? `The working tree has uncommitted changes; commit or stash them before cherry-picking onto '${targetBranch}'.`
          : `Worktree at '${holder.path}' has '${targetBranch}' checked out with uncommitted changes; commit or stash them there before cherry-picking.`,
      )
    }
    const res = await gitExec(['cherry-pick', hash], holder.path, log)
    return res.exitCode === 0 && !isCurrent ? inWorktree(res, holder.path) : res
  }

  const headName = await gitExec(['symbolic-ref', '--short', '-q', 'HEAD'], root, log)
  const original = headName.stdout.trim()
  if (!original) {
    const sha = await gitExec(['rev-parse', 'HEAD'], root, log)
    if (sha.exitCode !== 0) return sha
    return runCherryPickOnBranch(root, hash, targetBranch, sha.stdout.trim(), log)
  }
  return runCherryPickOnBranch(root, hash, targetBranch, original, log)
}

const runCherryPickOnBranch = async (
  root: string,
  hash: string,
  targetBranch: string,
  restoreRef: string,
  log: Log,
): Promise<GitExecResult> => {
  const co = await gitExec(['checkout', targetBranch], root, log)
  if (co.exitCode !== 0) return co
  const pick = await gitExec(['cherry-pick', hash], root, log)
  if (pick.exitCode !== 0) return pick // leave HEAD on target so the conflict is resolvable
  await gitExec(['checkout', restoreRef], root, log)
  return pick
}

export const revert = (root: string, hash: string, log: Log): Promise<GitExecResult> =>
  gitExec(['revert', '--no-edit', hash], root, log)

export const reset = (
  root: string,
  hash: string,
  mode: ResetMode,
  log: Log,
): Promise<GitExecResult> => gitExec(['reset', `--${mode}`, hash], root, log)

export const merge = (root: string, ref: string, log: Log): Promise<GitExecResult> =>
  gitExec(['merge', ref], root, log)

export const rebase = (root: string, ref: string, log: Log): Promise<GitExecResult> =>
  gitExec(['rebase', ref], root, log)

export const createBranch = (
  root: string,
  hash: string,
  name: string,
  checkoutNew: boolean,
  log: Log,
): Promise<GitExecResult> =>
  gitExec(checkoutNew ? ['checkout', '-b', name, hash] : ['branch', name, hash], root, log)

export const renameBranch = (
  root: string,
  name: string,
  newName: string,
  log: Log,
): Promise<GitExecResult> => gitExec(['branch', '-m', name, newName], root, log)

export const deleteBranch = (
  root: string,
  name: string,
  force: boolean,
  log: Log,
): Promise<GitExecResult> => gitExec(['branch', force ? '-D' : '-d', name], root, log)

export const pushBranch = (
  root: string,
  name: string,
  remote: string,
  force: boolean,
  log: Log,
): Promise<GitExecResult> =>
  gitExec(force ? ['push', '--force-with-lease', remote, name] : ['push', remote, name], root, log)

export type PullMode = 'default' | 'rebase' | 'autostash'

const PULL_ARGS: Record<PullMode, string[]> = {
  default: ['pull'],
  rebase: ['pull', '--rebase'],
  autostash: ['pull', '--rebase', '--autostash'],
}

/**
 * Pull `branch`. When it isn't checked out here, the pull runs where it can
 * without disturbing this working tree:
 *
 * - A branch held by another worktree (the classic case: `main` in the main
 *   tree while you work in a linked one) can't be checked out here — git
 *   rejects it with "already used by worktree". So the pull runs *inside that
 *   worktree's own directory*: its HEAD advances there and this tree never
 *   moves, no stash involved. That tree must be clean — autostash must not
 *   silently bury changes the user made in another window.
 * - Otherwise we stash pending changes (if any), check the branch out, pull,
 *   then restore the original HEAD and stash — the caller ends up exactly
 *   where they started, only with the branch advanced. A pull failure still
 *   restores HEAD and stash when it can (network failures shouldn't strand the
 *   user on a branch they didn't ask to be on); a conflict that blocks the
 *   restore checkout leaves HEAD on the target and the stash in the list for
 *   manual recovery.
 *
 * The dirty check is `status --porcelain`, which includes untracked files, so
 * the stash takes `--include-untracked` to match — anything less would not
 * fully restore the tree. On both redirected paths `--autostash` is a no-op
 * (the tree is already clean there); the argv still matches the SCM commands
 * so every mode behaves identically wherever the branch lives.
 */
export const pullBranch = async (
  root: string,
  branch: string,
  mode: PullMode,
  log: Log,
): Promise<GraphMutationResult> => {
  const args = PULL_ARGS[mode] ?? PULL_ARGS.default

  const headRes = await gitExec(['symbolic-ref', '--short', '-q', 'HEAD'], root, log)
  const restoreRef = headRes.stdout.trim()
  if (restoreRef === branch) return gitExec(args, root, log)

  // Redirect into the holding worktree before resolving a restore ref — the
  // redirected path never needs one (HEAD here doesn't move).
  const holder = await findBranchHolder(root, branch, log)
  if (holder) {
    // Defensive: the symbolic-ref shortcut above covers the on-branch case, and
    // porcelain reports no branch line for a detached tree, so this is unreachable.
    if (samePath(holder.path, root)) return gitExec(args, root, log)
    const status = await gitExec(['status', '--porcelain'], holder.path, log)
    if (status.exitCode !== 0) return status
    if (status.stdout.trim()) {
      return failure(
        `Worktree at '${holder.path}' has '${branch}' checked out with uncommitted changes; commit or stash them there before pulling.`,
      )
    }
    const res = await gitExec(args, holder.path, log)
    return res.exitCode === 0 ? inWorktree(res, holder.path) : res
  }

  // Resolve the restore ref before stashing anything: never stash without
  // knowing how to get back.
  let restore = restoreRef
  if (!restore) {
    const sha = await gitExec(['rev-parse', 'HEAD'], root, log)
    if (sha.exitCode !== 0) return sha
    restore = sha.stdout.trim()
  }

  const status = await gitExec(['status', '--porcelain'], root, log)
  if (status.exitCode !== 0) return status
  const stashed = status.stdout.trim() !== ''
  if (stashed) {
    const st = await gitExec(['stash', 'push', '--include-untracked'], root, log)
    if (st.exitCode !== 0) return st
  }

  const co = await gitExec(['checkout', branch], root, log)
  if (co.exitCode !== 0) {
    // HEAD never moved, so the pop cannot conflict — best-effort restore.
    if (stashed) await gitExec(['stash', 'pop'], root, log)
    return co
  }

  const pull = await gitExec(args, root, log)
  const back = await gitExec(['checkout', restore], root, log)
  if (back.exitCode !== 0) return back

  if (!stashed) return pull
  const pop = await gitExec(['stash', 'pop'], root, log)
  if (pop.exitCode !== 0) {
    if (pull.exitCode !== 0) {
      return failure(
        `${gitErrorText(pull)}\nFailed to restore stashed changes: ${gitErrorText(pop)}`,
      )
    }
    return pop
  }
  return pull
}

export const checkoutRemote = (
  root: string,
  remoteRef: string,
  localName: string,
  log: Log,
): Promise<GitExecResult> => gitExec(['checkout', '-b', localName, '--track', remoteRef], root, log)

/**
 * Reset an existing local branch to a remote-tracking ref's tip — the recovery
 * path for "checkout as local branch" when the name is already taken. When the
 * branch isn't checked out anywhere it is force-moved, then checked out here so
 * the outcome matches the original checkout intent. When a worktree holds the
 * branch, git refuses `branch -f`, so that worktree's HEAD is reset in place
 * instead — a dirty holding tree is refused, as `reset --hard` would discard
 * its uncommitted changes. Upstream is (re)pointed at the remote ref either way.
 */
export const resetBranchToRemote = async (
  root: string,
  remoteRef: string,
  localName: string,
  log: Log,
): Promise<GraphMutationResult> => {
  const holder = await findBranchHolder(root, localName, log)

  if (holder) {
    const isCurrent = samePath(holder.path, root)
    const status = await gitExec(['status', '--porcelain'], holder.path, log)
    if (status.exitCode !== 0) return status
    if (status.stdout.trim()) {
      return failure(
        isCurrent
          ? `The working tree has uncommitted changes; commit or stash them before resetting '${localName}'.`
          : `Worktree at '${holder.path}' has '${localName}' checked out with uncommitted changes; commit or stash them there before resetting.`,
      )
    }
    const res = await gitExec(['reset', '--hard', remoteRef], holder.path, log)
    if (res.exitCode !== 0) return res
    await gitExec(['branch', '--set-upstream-to', remoteRef, localName], root, log)
    return isCurrent ? res : inWorktree(res, holder.path)
  }

  const res = await gitExec(['branch', '-f', localName, remoteRef], root, log)
  if (res.exitCode !== 0) return res
  await gitExec(['branch', '--set-upstream-to', remoteRef, localName], root, log)
  return gitExec(['checkout', localName], root, log)
}

export const deleteRemoteBranch = async (
  root: string,
  remote: string,
  branch: string,
  log: Log,
): Promise<GitExecResult> => {
  const res = await gitExec(['push', remote, '--delete', branch], root, log)
  if (res.exitCode === 0) return res

  // Branch already gone on remote (stale local tracking ref) — prune to clean up
  if (res.stderr.includes('remote ref does not exist')) {
    return gitExec(['fetch', '--prune', remote], root, log)
  }

  return res
}

export const createTag = (
  root: string,
  hash: string,
  name: string,
  message: string | undefined,
  log: Log,
): Promise<GitExecResult> =>
  gitExec(message ? ['tag', '-a', name, '-m', message, hash] : ['tag', name, hash], root, log)

export const deleteTag = (root: string, name: string, log: Log): Promise<GitExecResult> =>
  gitExec(['tag', '-d', name], root, log)

export const pushTag = (
  root: string,
  name: string,
  remote: string,
  log: Log,
): Promise<GitExecResult> => gitExec(['push', remote, name], root, log)

export const stashApply = (root: string, selector: string, log: Log): Promise<GitExecResult> =>
  gitExec(['stash', 'apply', selector], root, log)

export const stashPop = (root: string, selector: string, log: Log): Promise<GitExecResult> =>
  gitExec(['stash', 'pop', selector], root, log)

export const stashDrop = (root: string, selector: string, log: Log): Promise<GitExecResult> =>
  gitExec(['stash', 'drop', selector], root, log)

/** One worktree the sync targets, identified by its on-disk path + display name. */
export interface SyncWorktreeRef {
  path: string
  name: string
}

export interface WorktreeSyncResult {
  synced: string[]
  skippedDirty: string[]
  skippedUnmerged: string[]
  skippedUnmatchedMessages: string[]
  failed: { name: string; error: string }[]
}

type SyncOutcome =
  | {
      kind: 'synced' | 'skippedDirty' | 'skippedUnmerged' | 'skippedUnmatchedMessages'
      name: string
    }
  | { kind: 'failed'; name: string; error: string }

type ForceCoverage =
  | { ok: true }
  | { ok: false; kind: 'skippedUnmatchedMessages' | 'failed'; error?: string }

/**
 * Force-mode guard: every commit `reset --hard <targetBranch>` would orphan must
 * have its subject present in the target's own history since the merge-base —
 * the cherry-pick / squash case, where the same change landed under a different
 * hash. Any unique commit whose subject is missing is treated as unhandled work
 * and blocks the force sync. Subjects (`%s`) rather than full bodies are matched
 * so cherry-pick footers / squash-concatenated bodies don't cause false refusals.
 */
const forceMessagesCovered = async (
  targetBranch: string,
  wt: SyncWorktreeRef,
  log: Log,
): Promise<ForceCoverage> => {
  const unique = await gitExec(['log', '--format=%s', `${targetBranch}..HEAD`], wt.path, log)
  if (unique.exitCode !== 0) return { ok: false, kind: 'failed', error: gitErrorText(unique) }
  // Trim each side, drop only the trailing empty artefact of the final newline —
  // a real empty subject stays and is refused below (never auto-approved).
  const uniqueSubjects = unique.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => l !== '' || i < a.length - 1)
  if (uniqueSubjects.length === 0) return { ok: true }

  const mb = await gitExec(['merge-base', targetBranch, 'HEAD'], wt.path, log)
  let targetLog: GitExecResult
  if (mb.exitCode === 0) {
    targetLog = await gitExec(
      ['log', '--format=%s', `${mb.stdout.trim()}..${targetBranch}`],
      wt.path,
      log,
    )
  } else if (mb.exitCode === 1) {
    // Unrelated histories: fall back to the target's full log so the check still holds.
    targetLog = await gitExec(['log', '--format=%s', targetBranch], wt.path, log)
  } else {
    return { ok: false, kind: 'failed', error: gitErrorText(mb) }
  }
  if (targetLog.exitCode !== 0) return { ok: false, kind: 'failed', error: gitErrorText(targetLog) }

  const targetSubjects = new Set(
    targetLog.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  )
  const uncovered = uniqueSubjects.filter((s) => s === '' || !targetSubjects.has(s))
  if (uncovered.length > 0) {
    log?.(
      `[git] force sync ${wt.name}: skipped — messages not in ${targetBranch}: ${uncovered.join('; ')}`,
    )
    return { ok: false, kind: 'skippedUnmatchedMessages' }
  }
  return { ok: true }
}

const syncOneWorktree = async (
  targetBranch: string,
  wt: SyncWorktreeRef,
  log: Log,
  force: boolean,
): Promise<SyncOutcome> => {
  const status = await gitExec(['status', '--porcelain'], wt.path, log)
  if (status.exitCode !== 0) return { kind: 'failed', name: wt.name, error: gitErrorText(status) }
  if (status.stdout.trim()) return { kind: 'skippedDirty', name: wt.name }
  // In normal mode, only reset when the worktree's commits are already in the
  // target — otherwise reset --hard would silently drop them. `git cherry
  // <target> HEAD` lists commits relative to the target: a `+` prefix marks a
  // change not yet present by patch-id. Force mode skips this and instead
  // requires every orphan-to-be commit's subject to appear in the target's own
  // history (cherry-pick / squash landings), refusing when any is unmatched.
  if (!force) {
    const cherry = await gitExec(['cherry', targetBranch, 'HEAD'], wt.path, log)
    if (cherry.exitCode !== 0) return { kind: 'failed', name: wt.name, error: gitErrorText(cherry) }
    const hasUnmerged = cherry.stdout.split('\n').some((line) => line.startsWith('+'))
    if (hasUnmerged) return { kind: 'skippedUnmerged', name: wt.name }
  } else {
    const cov = await forceMessagesCovered(targetBranch, wt, log)
    if (!cov.ok) {
      if (cov.kind === 'failed') return { kind: 'failed', name: wt.name, error: cov.error ?? '' }
      return { kind: 'skippedUnmatchedMessages', name: wt.name }
    }
  }
  const reset = await gitExec(['reset', '--hard', targetBranch], wt.path, log)
  if (reset.exitCode !== 0) return { kind: 'failed', name: wt.name, error: gitErrorText(reset) }
  const subUpdate = await updateSubmodules(wt.path, log)
  if (subUpdate.exitCode !== 0)
    return { kind: 'failed', name: wt.name, error: gitErrorText(subUpdate) }
  return { kind: 'synced', name: wt.name }
}

/**
 * Force every given worktree's branch to `targetBranch` via `git reset --hard`,
 * each command run inside that worktree's own directory. To avoid losing work, a
 * worktree is reset only when it is both clean (no uncommitted changes) and fully
 * contained in the target — i.e. every commit unique to the worktree already
 * exists in `targetBranch` by patch-id. `git cherry` is used rather than ancestry
 * (`merge-base --is-ancestor`) so squash/rebase-merged worktrees, whose commits
 * landed in the target under different hashes, are still recognised as merged.
 * Anything not mergeable is skipped into the matching bucket unless `force` is
 * set. Force mode still protects worktrees with uncommitted changes, and still
 * refuses when a commit the reset would orphan has no subject match in the
 * target's own history since the merge-base — only then does it discard the
 * remaining committed work. `targetBranch` is a ref name (e.g. `main`), so each
 * reset worktree's branch ends up exactly at the target commit.
 *
 * Worktrees are synced concurrently: each has its own working directory, index
 * and branch ref, so their pipelines don't contend (git takes per-ref locks).
 * Result buckets keep the input order regardless of completion order.
 */
export const syncWorktreesToBranch = async (
  targetBranch: string,
  worktrees: readonly SyncWorktreeRef[],
  log: Log,
  force = false,
): Promise<WorktreeSyncResult> => {
  const outcomes = await Promise.all(
    worktrees.map((wt) => syncOneWorktree(targetBranch, wt, log, force)),
  )
  const result: WorktreeSyncResult = {
    synced: [],
    skippedDirty: [],
    skippedUnmerged: [],
    skippedUnmatchedMessages: [],
    failed: [],
  }
  for (const outcome of outcomes) {
    if (outcome.kind === 'failed') result.failed.push({ name: outcome.name, error: outcome.error })
    else result[outcome.kind].push(outcome.name)
  }
  return result
}
