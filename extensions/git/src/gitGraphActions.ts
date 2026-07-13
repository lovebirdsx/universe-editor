/**
 * Git Graph mutating operations. Each helper targets an explicit object the user
 * right-clicked (a commit hash, branch, tag…) — unlike `repository.ts`, which
 * prompts interactively. Every call is a thin `gitExec` wrapper returning the
 * full result (stdout/stderr/exitCode); the caller in `extension.ts` surfaces
 * errors — stderr included — and refreshes.
 *
 * Read-only queries live in `gitGraphSource.ts`; this file only writes.
 */
import { gitExec, type GitExecResult } from './gitService.js'
import { gitErrorText } from './gitError.js'

export type ResetMode = 'soft' | 'mixed' | 'hard'

type Log = ((msg: string) => void) | undefined

export const checkout = (root: string, ref: string, log: Log): Promise<GitExecResult> =>
  gitExec(['checkout', ref], root, log)

export const cherrypick = (root: string, hash: string, log: Log): Promise<GitExecResult> =>
  gitExec(['cherry-pick', hash], root, log)

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

export const checkoutRemote = (
  root: string,
  remoteRef: string,
  localName: string,
  log: Log,
): Promise<GitExecResult> => gitExec(['checkout', '-b', localName, '--track', remoteRef], root, log)

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
  failed: { name: string; error: string }[]
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
 * set. Force mode still protects worktrees with uncommitted changes, but discards
 * committed work that is not contained in `targetBranch`. `targetBranch` is a ref
 * name (e.g. `main`), so each reset worktree's branch ends up exactly at the
 * target commit.
 */
export const syncWorktreesToBranch = async (
  targetBranch: string,
  worktrees: readonly SyncWorktreeRef[],
  log: Log,
  force = false,
): Promise<WorktreeSyncResult> => {
  const result: WorktreeSyncResult = {
    synced: [],
    skippedDirty: [],
    skippedUnmerged: [],
    failed: [],
  }
  for (const wt of worktrees) {
    const status = await gitExec(['status', '--porcelain'], wt.path, log)
    if (status.exitCode !== 0) {
      result.failed.push({ name: wt.name, error: gitErrorText(status) })
      continue
    }
    if (status.stdout.trim()) {
      result.skippedDirty.push(wt.name)
      continue
    }
    // In normal mode, only reset when the worktree's commits are already in the
    // target — otherwise reset --hard would silently drop them. `git cherry
    // <target> HEAD` lists commits relative to the target: a `+` prefix marks a
    // change not yet present by patch-id. Force mode deliberately skips this check.
    if (!force) {
      const cherry = await gitExec(['cherry', targetBranch, 'HEAD'], wt.path, log)
      if (cherry.exitCode !== 0) {
        result.failed.push({ name: wt.name, error: gitErrorText(cherry) })
        continue
      }
      const hasUnmerged = cherry.stdout.split('\n').some((line) => line.startsWith('+'))
      if (hasUnmerged) {
        result.skippedUnmerged.push(wt.name)
        continue
      }
    }
    const reset = await gitExec(['reset', '--hard', targetBranch], wt.path, log)
    if (reset.exitCode !== 0) {
      result.failed.push({ name: wt.name, error: gitErrorText(reset) })
      continue
    }
    const subUpdate = await gitExec(['submodule', 'update', '--init', '--recursive'], wt.path, log)
    if (subUpdate.exitCode === 0) result.synced.push(wt.name)
    else result.failed.push({ name: wt.name, error: gitErrorText(subUpdate) })
  }
  return result
}
