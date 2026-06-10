/**
 * Git Graph mutating operations. Each helper targets an explicit object the user
 * right-clicked (a commit hash, branch, tag…) — unlike `repository.ts`, which
 * prompts interactively. Every call is a thin `gitExec` wrapper returning a
 * uniform result; the caller in `extension.ts` surfaces errors and refreshes.
 *
 * Read-only queries live in `gitGraphSource.ts`; this file only writes.
 */
import { gitExec } from './gitService.js'

export type ResetMode = 'soft' | 'mixed' | 'hard'

type Log = ((msg: string) => void) | undefined

async function run(root: string, args: readonly string[], log: Log): Promise<boolean> {
  const res = await gitExec(args, root, log)
  return res.exitCode === 0
}

export const checkout = (root: string, ref: string, log: Log): Promise<boolean> =>
  run(root, ['checkout', ref], log)

export const cherrypick = (root: string, hash: string, log: Log): Promise<boolean> =>
  run(root, ['cherry-pick', hash], log)

export const revert = (root: string, hash: string, log: Log): Promise<boolean> =>
  run(root, ['revert', '--no-edit', hash], log)

export const reset = (root: string, hash: string, mode: ResetMode, log: Log): Promise<boolean> =>
  run(root, ['reset', `--${mode}`, hash], log)

export const merge = (root: string, ref: string, log: Log): Promise<boolean> =>
  run(root, ['merge', ref], log)

export const rebase = (root: string, ref: string, log: Log): Promise<boolean> =>
  run(root, ['rebase', ref], log)

export const createBranch = (
  root: string,
  hash: string,
  name: string,
  checkoutNew: boolean,
  log: Log,
): Promise<boolean> =>
  run(root, checkoutNew ? ['checkout', '-b', name, hash] : ['branch', name, hash], log)

export const renameBranch = (
  root: string,
  name: string,
  newName: string,
  log: Log,
): Promise<boolean> => run(root, ['branch', '-m', name, newName], log)

export const deleteBranch = (
  root: string,
  name: string,
  force: boolean,
  log: Log,
): Promise<boolean> => run(root, ['branch', force ? '-D' : '-d', name], log)

export const pushBranch = (
  root: string,
  name: string,
  remote: string,
  force: boolean,
  log: Log,
): Promise<boolean> =>
  run(root, force ? ['push', '--force-with-lease', remote, name] : ['push', remote, name], log)

export const checkoutRemote = (
  root: string,
  remoteRef: string,
  localName: string,
  log: Log,
): Promise<boolean> => run(root, ['checkout', '-b', localName, '--track', remoteRef], log)

export const createTag = (
  root: string,
  hash: string,
  name: string,
  message: string | undefined,
  log: Log,
): Promise<boolean> =>
  run(root, message ? ['tag', '-a', name, '-m', message, hash] : ['tag', name, hash], log)

export const deleteTag = (root: string, name: string, log: Log): Promise<boolean> =>
  run(root, ['tag', '-d', name], log)

export const pushTag = (root: string, name: string, remote: string, log: Log): Promise<boolean> =>
  run(root, ['push', remote, name], log)

export const stashApply = (root: string, selector: string, log: Log): Promise<boolean> =>
  run(root, ['stash', 'apply', selector], log)

export const stashPop = (root: string, selector: string, log: Log): Promise<boolean> =>
  run(root, ['stash', 'pop', selector], log)

export const stashDrop = (root: string, selector: string, log: Log): Promise<boolean> =>
  run(root, ['stash', 'drop', selector], log)
