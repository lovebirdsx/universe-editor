/**
 * Fast-forwarding a repository's worktrees after a pull. A pull only advances the
 * branch it targeted; every worktree sitting on the commit that was its tip a
 * moment ago stays behind and has to be pulled or reset by hand. This closes that
 * gap automatically.
 *
 * The worktree the pull ran in is not special-cased: a Git Graph pull of a branch
 * held by another worktree runs *there*, leaving the current tree behind just like
 * any other. Instead, a worktree whose HEAD already is the new commit lands in the
 * unreported `upToDate` bucket — which covers the plain-pull case without claiming
 * a tree moved when it never did.
 *
 * Only worktrees that can be fast-forwarded are touched: clean (no uncommitted
 * changes) and with a HEAD that is a strict ancestor of the new commit. Ancestry
 * — not `git cherry`'s patch-id comparison, which the *manual* worktree sync in
 * gitGraphActions.ts uses — is the right test here precisely because this runs
 * without the user asking: a patch-id match would let `reset --hard` discard real
 * commit objects that merely happen to carry equivalent content.
 *
 * A worktree on a branch has that branch's ref fast-forwarded along with it.
 * That is a deliberate, user-configured behaviour (`git.autoSyncWorktreesAfterPull`),
 * and the caller reports branch moves separately so they stay visible.
 *
 * Platform-dep free, like the other pure git helpers.
 */
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gitExec } from './gitService.js'
import { gitErrorText } from './gitError.js'
import { parseWorktrees, type WorktreeInfo } from './worktreeParser.js'
import { updateSubmodulesIfPresent } from './submoduleSync.js'

type Log = ((msg: string) => void) | undefined

/** A worktree whose branch ref was fast-forwarded along with its working tree. */
export interface SyncedBranchWorktree {
  readonly name: string
  readonly branch: string
}

export interface WorktreeAutoSyncResult {
  syncedDetached: string[]
  syncedBranches: SyncedBranchWorktree[]
  upToDate: string[]
  skippedDirty: string[]
  skippedInProgress: string[]
  skippedDiverged: string[]
  failed: { name: string; error: string }[]
}

type SyncOutcome =
  | {
      kind: 'syncedDetached' | 'upToDate' | 'skippedDirty' | 'skippedInProgress' | 'skippedDiverged'
      name: string
    }
  | { kind: 'syncedBranch'; name: string; branch: string }
  | { kind: 'failed'; name: string; error: string }

const emptyResult = (): WorktreeAutoSyncResult => ({
  syncedDetached: [],
  syncedBranches: [],
  upToDate: [],
  skippedDirty: [],
  skippedInProgress: [],
  skippedDiverged: [],
  failed: [],
})

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * A worktree halted mid-operation, or `undefined` if it is idle.
 *
 * `status --porcelain` stays silent about a paused rebase whose tree is clean, so
 * the marker files in the worktree's own git dir are the only reliable signal.
 * `--git-path` resolves them per worktree (a linked worktree's git dir lives under
 * the main repo's `worktrees/<name>/`, not in `<wt>/.git`).
 */
const pendingOperation = async (worktreePath: string, log: Log): Promise<string | undefined> => {
  const gitPath = await gitExec(['rev-parse', '--git-path', 'x'], worktreePath, log)
  if (gitPath.exitCode !== 0) return undefined
  const gitDir = gitPath.stdout.trim().replace(/x$/, '')
  if (!gitDir) return undefined

  const markers: readonly [string, string][] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ]
  for (const [file, label] of markers) {
    if (await exists(join(gitDir, file))) return label
  }
  return undefined
}

const syncOne = async (
  newHead: string,
  currentRoot: string,
  wt: WorktreeInfo,
  log: Log,
): Promise<SyncOutcome> => {
  const name = basename(wt.path)
  const synced = (): SyncOutcome =>
    wt.branch === undefined
      ? { kind: 'syncedDetached', name }
      : { kind: 'syncedBranch', name, branch: wt.branch }

  // Resolved first, before the dirty check: the worktree the pull ran in is
  // already at the new commit and may well carry uncommitted edits — reporting it
  // as "skipped (uncommitted changes)" would be noise about a tree that needs
  // nothing. `worktree list --porcelain` may abbreviate HEAD, so resolve the full
  // sha here for both the equality check and the ancestry test.
  const headRes = await gitExec(['rev-parse', 'HEAD'], wt.path, log)
  if (headRes.exitCode !== 0) return { kind: 'failed', name, error: gitErrorText(headRes) }
  const wtHead = headRes.stdout.trim()

  if (wtHead === newHead) {
    log?.(`[git] auto-sync worktree ${name}: already at ${newHead.slice(0, 8)}`)
    return { kind: 'upToDate', name }
  }

  const status = await gitExec(['status', '--porcelain'], wt.path, log)
  if (status.exitCode !== 0) return { kind: 'failed', name, error: gitErrorText(status) }
  if (status.stdout.trim()) {
    log?.(`[git] auto-sync worktree ${name}: skipped (uncommitted changes)`)
    return { kind: 'skippedDirty', name }
  }

  // A worktree paused mid-rebase/merge/cherry-pick/bisect has a clean tree, so
  // the check above waves it through — but resetting would silently destroy that
  // in-progress state. `status --porcelain` never reports it, hence the explicit probe.
  const pending = await pendingOperation(wt.path, log)
  if (pending !== undefined) {
    log?.(`[git] auto-sync worktree ${name}: skipped (${pending} in progress)`)
    return { kind: 'skippedInProgress', name }
  }

  // Ancestry is a property of the shared object database, so this runs in the
  // repository that just pulled — the worktree may not have the new commit's
  // refs, but it does share the objects.
  const ancestor = await gitExec(['merge-base', '--is-ancestor', wtHead, newHead], currentRoot, log)
  if (ancestor.exitCode === 1) {
    log?.(`[git] auto-sync worktree ${name}: skipped (has commits of its own)`)
    return { kind: 'skippedDiverged', name }
  }
  if (ancestor.exitCode !== 0) return { kind: 'failed', name, error: gitErrorText(ancestor) }

  const reset = await gitExec(['reset', '--hard', newHead], wt.path, log)
  if (reset.exitCode !== 0) return { kind: 'failed', name, error: gitErrorText(reset) }

  const sub = await updateSubmodulesIfPresent(wt.path, log)
  if (sub.ran && sub.result.exitCode !== 0) {
    return { kind: 'failed', name, error: gitErrorText(sub.result) }
  }

  log?.(`[git] auto-sync worktree ${name}: synced to ${newHead.slice(0, 8)}`)
  return synced()
}

/** Isolate one worktree's failure so a single bad tree can't sink the whole run. */
const syncOneSafely = async (
  newHead: string,
  currentRoot: string,
  wt: WorktreeInfo,
  log: Log,
): Promise<SyncOutcome> => {
  try {
    return await syncOne(newHead, currentRoot, wt, log)
  } catch (err) {
    return {
      kind: 'failed',
      name: basename(wt.path),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Fast-forward every worktree of `currentRoot` — including `currentRoot` itself —
 * that can reach `newHead` without losing work. `newHead` must be a full sha. A
 * worktree already on `newHead` lands in the unreported `upToDate` bucket and bare
 * worktrees are excluded; everything else lands in exactly one result bucket, in
 * input order regardless of completion order.
 *
 * Worktrees are processed concurrently — each owns its working directory, index
 * and refs, so their git invocations don't contend.
 */
export async function syncWorktreesToCommit(
  newHead: string,
  currentRoot: string,
  log?: Log,
): Promise<WorktreeAutoSyncResult> {
  const listRes = await gitExec(['worktree', 'list', '--porcelain'], currentRoot, log)
  if (listRes.exitCode !== 0) {
    log?.(`[git] auto-sync worktrees: listing failed — ${gitErrorText(listRes)}`)
    return emptyResult()
  }

  const candidates = parseWorktrees(listRes.stdout).filter((wt) => !wt.bare)
  if (candidates.length === 0) return emptyResult()

  log?.(`[git] auto-sync worktrees: ${candidates.length} candidate(s) for ${newHead.slice(0, 8)}`)
  const outcomes = await Promise.all(
    candidates.map((wt) => syncOneSafely(newHead, currentRoot, wt, log)),
  )

  const result = emptyResult()
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'failed':
        result.failed.push({ name: outcome.name, error: outcome.error })
        break
      case 'syncedBranch':
        result.syncedBranches.push({ name: outcome.name, branch: outcome.branch })
        break
      default:
        result[outcome.kind].push(outcome.name)
    }
  }
  return result
}
