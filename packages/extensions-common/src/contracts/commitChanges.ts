/**
 * Commit-changes wire types, shared by the renderer (which renders the
 * Commit Changes sidebar view) and, structurally, by the `git` / `perforce`
 * extensions (which build the payload — extensions keep local copies of these
 * shapes to avoid bundling this package).
 *
 * The payload carries per-file *metadata* only: the view shows a file tree,
 * and a single file's diff content is fetched on demand by executing
 * `openExternalCommand`, which opens a dedicated single-file diff editor.
 */

/** One changed file in a commit-changes payload — metadata only, no content. */
export interface CommitChangesFileEntry {
  /** Current path (the new path for renames), for display and language pick. */
  path: string
  /** Original path for renames, else null. */
  oldPath: string | null
  /** Single-letter status: A/M/D/R/C/T/U. */
  status: string
  /** Local file URI (as string) when the file exists in the workspace, else null. */
  resourceUri: string | null
  /** Provider-private argument passed verbatim to openExternalCommand. */
  args: unknown
}

/** Optional commit metadata rendered in the view header. */
export interface CommitChangesMetadata {
  author?: string
  /** Unix seconds. */
  authorDate?: number
  /** Full commit message including body. */
  message?: string
  /** Parent hashes — single-commit mode only. */
  parents?: string[]
  /** Set in compare mode ("from ↔ to"); mutually exclusive with parents. */
  compareRefs?: { from: string; to: string }
}

/** Argument of `_workbench.showCommitChanges` — one commit's (or CL's) changes. */
export interface ShowCommitChangesPayload {
  /** SCM provider id, e.g. 'git' | 'perforce'. */
  providerId: string
  /** Header title, e.g. 'a1b2c3d — fix crash' or 'a1b2c3d ↔ e5f6g7h'. */
  title: string
  /** Secondary line, e.g. author + date. */
  subtitle?: string
  /** Commit hash or changelist number — the identity key per provider. */
  commitRef: string
  /** Command opening a single file's diff in a dedicated editor. */
  openExternalCommand: string
  files: CommitChangesFileEntry[]
  /**
   * One entry's `path` the view should scroll into view — set by the provider
   * when the caller opened the changes from a specific file (blame /
   * timeline). Absent when there's nothing to reveal.
   */
  revealPath?: string
  metadata?: CommitChangesMetadata
  /**
   * When true, the view's content is updated without revealing the SCM
   * container or expanding the view — used by selection-follow (e.g. a graph
   * reveal syncing the sidebar) where yanking the sidebar open would steal
   * the user's context. Absent/false keeps the default reveal behaviour.
   */
  silent?: boolean
}
