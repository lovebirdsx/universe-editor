/**
 * Pure parsing of `git worktree list --porcelain`. Kept dependency-free so both
 * the SCM `Repository` (which carries platform deps) and the bundled
 * `gitGraphSource` (which deliberately avoids them) can share it.
 */

/** A single linked working tree, as reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
  readonly path: string
  /** Short branch name, or undefined when detached / bare. */
  readonly branch: string | undefined
  /** Abbreviated-or-full HEAD commit, or undefined for a bare worktree. */
  readonly head: string | undefined
  readonly bare: boolean
  readonly detached: boolean
  /** The first entry is always the main working tree. */
  readonly isMain: boolean
}

/**
 * Parse `git worktree list --porcelain` output. Records are blank-line separated;
 * each line is a `key value` pair (or a bare key like `bare` / `detached`). The
 * first record is the main working tree. `branch` carries a full ref
 * (`refs/heads/x`) which we shorten for display.
 */
export function parseWorktrees(stdout: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = []
  let path: string | undefined
  let head: string | undefined
  let branch: string | undefined
  let bare = false
  let detached = false

  const flush = (): void => {
    if (path === undefined) return
    result.push({ path, branch, head, bare, detached, isMain: result.length === 0 })
    path = undefined
    head = undefined
    branch = undefined
    bare = false
    detached = false
  }

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') {
      flush()
      continue
    }
    const sep = line.indexOf(' ')
    const key = sep === -1 ? line : line.slice(0, sep)
    const value = sep === -1 ? '' : line.slice(sep + 1)
    switch (key) {
      case 'worktree':
        path = value
        break
      case 'HEAD':
        head = value
        break
      case 'branch':
        branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
        break
      case 'bare':
        bare = true
        break
      case 'detached':
        detached = true
        break
    }
  }
  flush()
  return result
}
