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
