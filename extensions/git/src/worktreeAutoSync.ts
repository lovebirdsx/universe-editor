/**
 * Post-pull worktree auto-sync entrypoint, shared by the SCM pull commands and
 * the Git Graph pull command. The pure sync engine lives in worktreeSync.ts
 * (platform-dep free); this module adds the configuration gate, resolves the
 * commit to fast-forward to, and reports the outcome through extension API
 * notifications — so it must stay out of the pure helpers.
 */
import { window, workspace } from '@universe-editor/extension-api'
import { gitExec } from './gitService.js'
import { localize } from './nls.js'
import { syncWorktreesToCommit, type WorktreeAutoSyncResult } from './worktreeSync.js'

type Log = ((msg: string) => void) | undefined

export function reportWorktreeAutoSync(result: WorktreeAutoSyncResult): void {
  const lines: string[] = []
  if (result.syncedDetached.length > 0) {
    lines.push(
      localize('git.worktree.autoSyncSynced', 'Synced worktrees: {0}', {
        0: result.syncedDetached.join(', '),
      }),
    )
  }
  // Branch moves are called out separately: the branch ref itself advanced, not
  // just the working tree, and that is worth seeing.
  for (const wt of result.syncedBranches) {
    lines.push(
      localize('git.worktree.autoSyncSyncedBranch', "Worktree '{0}': branch '{1}' fast-forwarded", {
        0: wt.name,
        1: wt.branch,
      }),
    )
  }
  if (result.skippedDirty.length > 0) {
    lines.push(
      localize('git.worktree.autoSyncSkippedDirty', 'Skipped (uncommitted changes): {0}', {
        0: result.skippedDirty.join(', '),
      }),
    )
  }
  if (result.skippedInProgress.length > 0) {
    lines.push(
      localize(
        'git.worktree.autoSyncSkippedInProgress',
        'Skipped (rebase/merge in progress): {0}',
        { 0: result.skippedInProgress.join(', ') },
      ),
    )
  }
  if (result.skippedDiverged.length > 0) {
    lines.push(
      localize('git.worktree.autoSyncSkippedDiverged', 'Skipped (commits of their own): {0}', {
        0: result.skippedDiverged.join(', '),
      }),
    )
  }
  for (const f of result.failed) {
    lines.push(
      localize('git.worktree.autoSyncFailed', "Worktree '{0}' failed: {1}", {
        0: f.name,
        1: f.error,
      }),
    )
  }
  if (lines.length === 0) return
  const message = lines.join('\n')
  if (result.failed.length > 0) void window.showWarningMessage(message)
  else void window.showInformationMessage(message)
}

/**
 * Fast-forward the repository's worktrees to `targetRef`'s commit, when
 * `git.autoSyncWorktreesAfterPull` is enabled. The SCM pull commands pass
 * `'HEAD'` (a pull always moves HEAD there); the Git Graph pull command passes
 * the pulled branch — it may have run in another worktree, or checked the branch
 * out here and back again, so only the branch ref knows where the pull landed.
 *
 * Whichever worktree the pull actually ran in is already on that commit, so the
 * sync engine passes it over silently; no path bookkeeping is needed here.
 */
export async function autoSyncWorktreesAfterPull(
  root: string,
  targetRef: string,
  log?: Log,
): Promise<void> {
  const enabled = await workspace.getConfiguration('git').get('autoSyncWorktreesAfterPull', true)
  if (!enabled) {
    log?.('[git] skip worktree sync: git.autoSyncWorktreesAfterPull is disabled')
    return
  }
  const headRes = await gitExec(['rev-parse', targetRef], root, log)
  if (headRes.exitCode !== 0) return
  const newHead = headRes.stdout.trim()
  if (!newHead) return

  reportWorktreeAutoSync(await syncWorktreesToCommit(newHead, root, log))
}
