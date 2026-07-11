/**
 * Perforce Graph wire types, shared by the renderer (which calls the commands)
 * and, structurally, by the `perforce` extension (which implements them — the
 * extension keeps a local copy of these shapes to avoid bundling this package).
 *
 * Data crosses the contributed-command boundary as plain JSON: the renderer
 * calls `commands.executeCommand(PerforceGraphCommands.*, ...)` and the
 * `perforce` extension's handler returns one of the DTOs below.
 *
 * Perforce's history model differs from git: instead of a commit DAG there is a
 * strictly ordered list of *submitted changelists* (numbered). The graph is
 * therefore a single lane — each change's only "parent" is the next-older change
 * in the list — reusing the same swim-lane layout the Git Graph view uses. Dates
 * are Unix seconds.
 */

/** A single submitted changelist, one row in the graph. */
export interface P4GraphChangeDto {
  /** Changelist number as a string (used as the graph node id). */
  id: string
  /** The next-older change's id, or empty when this is the first loaded row. */
  parents: string[]
  /** Submitting user. */
  author: string
  /** Client (workspace) the change was submitted from. */
  client: string
  /** Submit date, Unix seconds. */
  date: number
  /** Description first line. Full body is fetched on demand. */
  message: string
}

/** A client (workspace) the Perforce Graph view can target. */
export interface P4GraphRepoDto {
  /** Absolute path of the client root. */
  root: string
  /** Display name (the client name). */
  name: string
}

/** Options for `perforce-graph.getChanges`. */
export interface P4GraphLoadOptions {
  /** Upper bound on changes returned. */
  maxChanges?: number
}

/** Result of `perforce-graph.getChanges`. */
export interface P4GraphLoadResult {
  changes: P4GraphChangeDto[]
  /** Latest submitted change id, or null when the depot has none. */
  head: string | null
  /** The current client name, or null when it can't be resolved. */
  headClient: string | null
  /** True when more changes exist beyond `maxChanges`. */
  moreAvailable: boolean
  /** Number of files currently open in the workspace (the synthetic "pending" node). */
  pendingCount: number
}

/** A single file changed by a submitted change (or between two changes). */
export interface P4GraphFileChangeDto {
  /** Single-letter status derived from the p4 action: A/M/D/R. */
  status: string
  /** Display path (depot path without the leading `//`). */
  path: string
  /** Original path for move/add rows, else null. */
  oldPath: string | null
  /** Full depot path, for p4 operations. */
  depotFile: string
  /** Revision number at this change. */
  rev: string
  /** Resolved local filesystem path, or null when the file isn't in the client view. */
  localPath: string | null
}

/** Full detail of one change, loaded on demand when a row is selected. */
export interface P4GraphChangeDetailsDto {
  id: string
  author: string
  client: string
  /** Submit date, Unix seconds. */
  date: number
  /** Full description (all lines). */
  body: string
  files: P4GraphFileChangeDto[]
}

/**
 * Argument for `perforce-graph.openFileDiff` — opens a submitted file's diff in a
 * diff editor. The extension derives the two revisions to compare from the file's
 * status + revision (`rev` vs `rev-1`).
 */
export interface P4GraphFileDiffRequest {
  /** Full depot path. */
  depotFile: string
  /** Single-letter status (A/M/D/R). */
  status: string
  /** Revision number this change created. */
  rev: string
  /**
   * Resolved local filesystem path, or null when the file isn't in the client
   * view. Lets the diff editor's "Open File" button reopen the working-tree copy;
   * omitted/null hides that button (depot blobs have no local counterpart).
   */
  localPath?: string | null
}

/**
 * Contributed-command ids the `perforce` extension registers for the Perforce
 * Graph view. Kept here as the single source of truth for the renderer side.
 * All are read-only — the Perforce Graph does not mutate the depot.
 */
export const PerforceGraphCommands = {
  getRepos: 'perforce-graph.getRepos',
  setRepo: 'perforce-graph.setRepo',
  getChanges: 'perforce-graph.getChanges',
  getChangeDetails: 'perforce-graph.getChangeDetails',
  getPendingChanges: 'perforce-graph.getPendingChanges',
  openFileDiff: 'perforce-graph.openFileDiff',
  openWorkingTreeFile: 'perforce-graph.openWorkingTreeFile',
} as const

export type PerforceGraphCommandId =
  (typeof PerforceGraphCommands)[keyof typeof PerforceGraphCommands]
