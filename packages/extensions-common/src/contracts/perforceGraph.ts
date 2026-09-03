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
  /** Description first line. */
  message: string
  /** Full description (all lines) — the list call (`p4 changes -l`) already
   *  returns it, so no on-demand fetch is needed (unlike git). */
  body: string
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
  /**
   * When true, list changes across the whole client depot (`//...`); otherwise
   * (the default) scope to the opened workspace folder so the graph mirrors what
   * the user actually has open.
   */
  wholeRepo?: boolean
  /**
   * 把历史限定到这些 host 路径（文件和/或目录）。非空时忽略 wholeRepo。
   *
   * 多路径 = 合并历史：列出影响**任一**路径的已提交 changelist 并集（`p4 changes`
   * 接受多个 filespec）。形态与 {@link P4GraphSyncRequest.scopePaths} 一致，所以
   * 同一份选区能原样喂给读（历史）与写（get revision）两条路。
   */
  scopePaths?: readonly { path: string; isDirectory: boolean }[]
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
  /**
   * Root of the client this result was read from. The renderer echoes it back on
   * `getChangeDetails` / `openFileDiff` so those reads land on the same client —
   * a scoped graph resolves its client by path (`resolveContaining`), which need
   * not be the graph's ambient/active one.
   */
  clientRoot?: string
  /**
   * Set instead of a normal listing when the request could not be answered as
   * asked. `multiClient`: the requested `scopePaths` span more than one Perforce
   * client, so there is no single history to merge (mirrors sync, which also
   * aborts). The extension has already surfaced an error notification; the
   * renderer only needs a distinct empty state.
   */
  error?: 'multiClient'
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
 * Optional second argument of `perforce-graph.getChangeDetails` (after the
 * changelist id): pins the read to a specific client, for the same reason
 * {@link P4GraphLoadResult.clientRoot} exists. Omitted → the graph's ambient client.
 */
export interface P4GraphChangeDetailsOptions {
  clientRoot?: string
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
  /** Client root to read from — see {@link P4GraphLoadResult.clientRoot}. */
  clientRoot?: string | null
}

/**
 * A candidate directory for the graph's multi-directory "Get Revision…"
 * dialog: one top-level directory of the graph client's root.
 */
export interface P4GraphSyncScopeDto {
  /** Directory basename, for display. */
  name: string
  /** Absolute host filesystem path. */
  path: string
}

/**
 * Argument for `perforce-graph.syncToChange` — P4V-style "get revision as of a
 * changelist". Runs a `p4 sync` scoped to the change: it moves the workspace's
 * *have* revisions (rolling files back or forward in time), never the depot.
 */
export interface P4GraphSyncRequest {
  /** Changelist number as a string (the graph row id). */
  change: string
  /**
   * Explicit sync scope as host paths. When non-empty it overrides the
   * graph-derived scope; directories become `<dir>/...` filespecs.
   */
  scopePaths?: readonly { path: string; isDirectory: boolean }[]
  /**
   * Without `scopePaths` (the unscoped graph): sync `//...` instead of the
   * opened workspace folder — mirrors the graph's whole-repo toggle.
   */
  wholeRepo?: boolean
  /**
   * The target row is the newest loaded change for the displayed scope. A
   * get-latest equivalent, so the time-travel confirmation is skipped.
   */
  isLatest?: boolean
  /**
   * The request comes from the multi-directory dialog, whose confirm button
   * already is the user's go-ahead — skip the extra warning.
   */
  confirmed?: boolean
}

/**
 * Contributed-command ids the `perforce` extension registers for the Perforce
 * Graph view. Kept here as the single source of truth for the renderer side.
 * All are read-only except `syncToChange`, which mutates the workspace's have
 * revisions (a `p4 sync`) but never the depot.
 */
export const PerforceGraphCommands = {
  getRepos: 'perforce-graph.getRepos',
  setRepo: 'perforce-graph.setRepo',
  getChanges: 'perforce-graph.getChanges',
  getChangeDetails: 'perforce-graph.getChangeDetails',
  getPendingChanges: 'perforce-graph.getPendingChanges',
  openFileDiff: 'perforce-graph.openFileDiff',
  openWorkingTreeFile: 'perforce-graph.openWorkingTreeFile',
  syncToChange: 'perforce-graph.syncToChange',
  getSyncScopes: 'perforce-graph.getSyncScopes',
} as const

export type PerforceGraphCommandId =
  (typeof PerforceGraphCommands)[keyof typeof PerforceGraphCommands]
