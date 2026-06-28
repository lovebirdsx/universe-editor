/**
 * Shared types, input-command constants and pure classifiers for the git
 * repository. Split out of repository.ts so the core class file stays focused on
 * orchestration. No I/O here — everything is data or a pure function.
 */
import type { Command } from '@universe-editor/extension-api'

export interface RefreshOptions {
  readonly fetch?: boolean
  readonly silent?: boolean
}

export interface FetchOptions {
  readonly prune?: boolean
  readonly silent?: boolean
}

export interface RepositoryOptions {
  /** SourceControl label shown in the SCM view header (e.g. `Git: <submodule>`). */
  readonly label?: string
}

/** Branch / sync state the shared status-bar controller renders. */
export interface RepoStatus {
  readonly branch: string | undefined
  readonly ahead: number
  readonly behind: number
  /** Non-null while an operation runs: the spinner text + kind to display. */
  readonly busy: { readonly text: string; readonly kind: 'syncing' | 'spinning' } | undefined
}

export const GIT_COMMIT_INPUT_COMMAND: Command = { command: 'git.commit', title: 'Commit' }
export const GIT_COMMIT_DISABLED_INPUT_COMMAND: Command = {
  command: 'git.commit',
  title: 'Commit',
  disabled: true,
}
export const GIT_PULL_INPUT_COMMAND: Command = { command: 'git.pull', title: 'Pull' }
export const GIT_PULL_REBASE_INPUT_COMMAND: Command = {
  command: 'git.pullRebase',
  title: 'Pull Rebase',
}
export const GIT_PUSH_INPUT_COMMAND: Command = { command: 'git.push', title: 'Push' }

/** Pick the SCM input box's primary action from the repo's change / sync state. */
export function gitPrimaryInputCommand({
  hasChanges,
  ahead,
  behind,
}: {
  readonly hasChanges: boolean
  readonly ahead: number
  readonly behind: number
}): Command {
  if (hasChanges) return GIT_COMMIT_INPUT_COMMAND
  if (ahead > 0 && behind > 0) return GIT_PULL_REBASE_INPUT_COMMAND
  if (ahead > 0) return GIT_PUSH_INPUT_COMMAND
  if (behind > 0) return GIT_PULL_INPUT_COMMAND
  return GIT_COMMIT_DISABLED_INPUT_COMMAND
}

export type WorktreeRemoveFailure = 'busy' | 'dirty-or-locked' | 'submodule' | 'other'

/**
 * Classify why `git worktree remove` failed from its stderr. A worktree whose
 * directory (or a file under it) is still held by a running process — most often
 * an editor window opened on that worktree, or its integrated terminal — fails
 * with EBUSY/EPERM/EINVAL-style messages that `--force` cannot fix; deleting it
 * needs the holding process closed first. A dirty or locked worktree, by
 * contrast, is exactly what `--force` is for. A worktree with initialized
 * submodules is refused outright by git (even with `--force`); it must have its
 * submodules deinitialized first.
 */
export function classifyWorktreeRemoveFailure(stderr: string): WorktreeRemoveFailure {
  const msg = stderr.toLowerCase()
  if (
    msg.includes('invalid argument') ||
    msg.includes('permission denied') ||
    msg.includes('access is denied') ||
    msg.includes('being used by another process') ||
    msg.includes('resource busy') ||
    msg.includes('device or resource busy') ||
    msg.includes('operation not permitted')
  ) {
    return 'busy'
  }
  if (msg.includes('containing submodules')) {
    return 'submodule'
  }
  if (
    msg.includes('contains modified or untracked files') ||
    msg.includes('use --force') ||
    msg.includes('is dirty') ||
    msg.includes('locked working tree') ||
    msg.includes('is locked')
  ) {
    return 'dirty-or-locked'
  }
  return 'other'
}
