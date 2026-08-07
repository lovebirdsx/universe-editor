/**
 * Dirty-diff wire contract, shared by the renderer (which renders the gutter /
 * overview-ruler decorations) and any SCM extension (which reads the baseline
 * revision). The renderer resolves the owning provider for a file and calls
 * `commands.executeCommand('<providerId>.getHeadContent', fsPath)`; the handler
 * returns the file's content at the SCM baseline (git HEAD, p4 `#have`, …) as a
 * string, or null when the file has no baseline (untracked / new) or lives
 * outside any repo.
 *
 * Command ids are provider-scoped (`git.getHeadContent`, `perforce.getHeadContent`)
 * so the host holds no SCM-specific knowledge — it derives the id from whichever
 * provider owns the path.
 */

/** Command-id suffixes each SCM provider contributes, joined to its provider id. */
export const DirtyDiffCapabilities = {
  getHeadContent: 'getHeadContent',
  /**
   * Stage a single change hunk. Args: `(fsPath, startLine, endLine)` — the 1-based
   * current-document line range of the dirty-diff region to stage. Returns whether
   * anything was staged. Providers without a staging area (e.g. Perforce) simply
   * don't register it, and the host hides the Stage affordance.
   */
  stageChange: 'stageChange',
  /** Open the file's changes as a diff editor. Args: `(fsPath?, options?)`. */
  openChange: 'openChange',
  /**
   * Filter a batch of paths down to those the SCM ignores (gitignore & friends).
   * Args: `(fsPaths: string[])`; returns the ignored subset, each element identical
   * to the input string it came from. Paths outside any repo report as not
   * ignored. The session diff's fs-watch fallback uses this to drop noise like
   * `.eslintcache` that would otherwise surface as a spurious "created" row.
   */
  checkIgnore: 'checkIgnore',
} as const

/** Build a provider-scoped dirty-diff command id, e.g. `('git','getHeadContent')
 *  → 'git.getHeadContent'`. */
export function dirtyDiffCommandId(
  providerId: string,
  capability: keyof typeof DirtyDiffCapabilities,
): string {
  return `${providerId}.${DirtyDiffCapabilities[capability]}`
}
