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
  /**
   * Filter a batch of paths down to those with working-tree changes the provider
   * does NOT already publish through its resource groups. Args:
   * `(fsPaths: string[])`; returns one {@link WorkingTreeChangeDto} per changed
   * path, each `path` identical to the input string it came from.
   *
   * This exists because a provider's resource groups can be an incomplete picture
   * of the disk: Perforce only knows about files you explicitly opened, and its
   * `reconcile` discovery of everything else is a server round-trip too costly to
   * run eagerly. Providers whose groups already are the disk truth (git) don't
   * register it, and the host falls back to publishing nothing.
   */
  checkWorkingTree: 'checkWorkingTree',
  /**
   * Filter a batch of paths down to those whose have revision is behind the
   * depot head (the server has newer revisions). Args: `(fsPaths: string[])`;
   * returns the behind subset, each element identical to the input string it
   * came from. Providers that cannot cheaply answer (git already decorates
   * fetch/push) don't register it, and the host falls back to publishing
   * nothing. Perforce registers it; the renderer uses it to probe visible rows
   * on demand, while the provider pushes the actual ↓ decoration through
   * setSupplementaryDecorations.
   */
  checkBehind: 'checkBehind',
} as const

/**
 * One changed path from {@link DirtyDiffCapabilities.checkWorkingTree}, carrying
 * the same presentation fields a resource state would — so the row looks
 * identical whether the status arrived on demand or through a resource group.
 */
export interface WorkingTreeChangeDto {
  /** Local path, byte-identical to the input string it was resolved from. */
  readonly path: string
  /** Single status letter for the row badge. */
  readonly letter: string
  readonly color: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
}

/** Build a provider-scoped dirty-diff command id, e.g. `('git','getHeadContent')
 *  → 'git.getHeadContent'`. */
export function dirtyDiffCommandId(
  providerId: string,
  capability: keyof typeof DirtyDiffCapabilities,
): string {
  return `${providerId}.${DirtyDiffCapabilities[capability]}`
}
