/**
 * Turns a failed `gitExec` result into a user-facing notification. The goal: the
 * reason a git operation failed should be readable straight from the toast, not
 * hidden behind "see the Git output". git already writes the real cause to
 * stderr — `gitErrorText` surfaces it, `classifyGitError` adds a short actionable
 * hint for the handful of failures users hit most, and `notifyGitFailure` shows
 * both plus a button that opens the full Git log for the long tail.
 */
import { window } from '@universe-editor/extension-api'
import type { GitExecResult } from './gitService.js'
import { localize } from './nls.js'

/** The raw reason a git command failed: stderr first, stdout as fallback,
 *  exit-code as a last resort so the toast never ends in a bare "failed:". */
export function gitErrorText(res: GitExecResult): string {
  return res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`
}

/**
 * A one-line, action-oriented hint for common git failures, or undefined when we
 * have nothing better to add than the raw message. Matched against stderr+stdout
 * because git splits its diagnostics across both depending on the subcommand.
 */
export function classifyGitError(res: GitExecResult): string | undefined {
  const msg = `${res.stderr}\n${res.stdout}`.toLowerCase()

  if (msg.includes('not fully merged')) {
    return localize(
      'git.error.notFullyMerged',
      'the branch has unmerged commits — use force delete to discard them',
    )
  }
  if (
    msg.includes('non-fast-forward') ||
    msg.includes('updates were rejected') ||
    msg.includes('tip of your current branch is behind')
  ) {
    return localize(
      'git.error.nonFastForward',
      "the remote has commits you don't have locally — pull first, or force push",
    )
  }
  if (
    msg.includes('would be overwritten') ||
    msg.includes('your local changes') ||
    msg.includes('commit your changes or stash them')
  ) {
    return localize('git.error.localChanges', 'commit or stash your local changes first')
  }
  if (msg.includes('conflict')) {
    return localize('git.error.conflict', 'resolve the conflicts, then continue')
  }
  if (
    msg.includes('did not match any') ||
    msg.includes('unknown revision') ||
    msg.includes('pathspec') ||
    msg.includes('not a valid ref')
  ) {
    return localize('git.error.notFound', 'no such branch, tag, or commit')
  }
  if (msg.includes('could not read from remote') || msg.includes('repository not found')) {
    return localize(
      'git.error.remoteUnreachable',
      'the remote is unreachable — check the URL and your network',
    )
  }
  if (msg.includes('authentication failed') || msg.includes('permission denied (publickey)')) {
    return localize('git.error.authFailed', 'authentication failed — check your credentials')
  }
  return undefined
}

/** Opens the Git output channel; wired up by `activate`. */
let showGitLog: (() => void) | undefined

export function setGitLogShower(fn: () => void): void {
  showGitLog = fn
}

const OPEN_LOG = localize('git.btn.openGitLog', 'Open Git Log')

/**
 * Surface a failed git command: `Git <label> failed: <reason> — <hint>`, with an
 * "Open Git Log" button for the full output. `label` is the human verb for the
 * operation, e.g. 'commit', 'delete branch'.
 */
export async function notifyGitFailure(label: string, res: GitExecResult): Promise<void> {
  const hint = classifyGitError(res)
  const message = `Git ${label} failed: ${gitErrorText(res)}${hint ? ` — ${hint}` : ''}`
  const items = showGitLog ? [OPEN_LOG] : []
  const picked = await window.showErrorMessage(message, ...items)
  if (picked === OPEN_LOG) showGitLog?.()
}
