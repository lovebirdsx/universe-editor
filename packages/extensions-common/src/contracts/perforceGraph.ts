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

/**
 * Argument for `perforce-graph.getHaveChange`. Same scope shape as the listing
 * it annotates, so the id it answers with is one the loaded rows can carry.
 * `maxChanges` is ignored (the probe is always `-m 1`).
 *
 * The resolved filespecs are the listing's own, with one deliberate exception:
 * the `wholeRepo` listing asks for `//...`, which accepts no revision specifier
 * at all, so its probe asks the client root's wildcard instead (see
 * `docs/graph.md`). A client's have revisions are a subset of what `//...`
 * lists, so that id is still one of the loaded rows.
 */
export interface P4GraphHaveChangeOptions extends P4GraphLoadOptions {
  /**
   * Re-run the probe even when a recent answer is cached. Set only by an
   * explicit reload (the toolbar refresh): re-running it costs the size of the
   * scope (tens of seconds over a whole workspace), while background
   * revalidations deliberately share one long-lived answer.
   */
  force?: boolean
}

/** Answer of the graph's have-point probe (`perforce-graph.getHaveChange`). */
export interface P4GraphHaveChangeResult {
  /** Newest submitted change already in the workspace's have list for the
   *  scope, or null when the scope holds nothing synced — a real answer. */
  id: string | null
  /** The probe could not answer at all (p4 failed or timed out, or the scope did
   *  not resolve to a client). `id` is null then and carries no information: the
   *  renderer keeps the badge it already had rather than dropping one that is
   *  most likely still correct. */
  failed: boolean
}

/** Where a local sync point came from. */
export type P4GraphSyncPointSource = 'sync' | 'query'

/**
 * Where the displayed scope's pulled history ends — the graph's local sync
 * point, and everything the badge and the toolbar line are drawn from.
 *
 * This is normally answered from the editor's own ledger of the gets it ran
 * (`extensions/perforce/src/graphSyncLedger.ts`), which costs nothing: the old
 * behaviour — asking p4 `#have` on every load and scope switch — paid the size
 * of the scope each time (tens of seconds over a wide workspace). The graph
 * therefore also has to be honest about the answer's provenance, which is what
 * `source`, `at`, `widerScope` and `partial` are for: a recorded answer says
 * nothing about a `p4 sync` run outside the editor since, and only an explicit
 * query reflects it.
 */
export interface P4GraphSyncPoint {
  /** The changelist id. */
  id: string
  /** `sync`: recorded by a get this editor ran. `query`: answered by p4 just now
   *  (`perforce-graph.getHaveChange`, which also overwrites the ledger — truth
   *  beats bookkeeping, and a stale entry must not be able to freeze). */
  source: P4GraphSyncPointSource
  /** Epoch ms the answer was established: the get's completion, or the query's
   *  run. Surfaced in the tooltip. */
  at: number
  /**
   * The answer comes from a get whose scope is WIDER than the one displayed, so
   * it is an upper bound: a wider get also moved files outside this scope, and
   * the newest of those need not touch this scope at all. Same over-report the
   * whole-repo probe avoids by not narrowing to the client root — it must be
   * labelled, never shown as exact.
   */
  widerScope: boolean
  /**
   * The recorded get did not land every file at the target revision (p4 refused
   * some, kept an opened file, or needs a resolve first), so the scope is only
   * known to be synced AT LEAST this far. An upper bound again, from a
   * different cause than {@link widerScope}.
   */
  partial: boolean
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
 * The scope a graph LISTING was filtered by — the coordinates the rows on screen
 * actually answer to. Deliberately the listing's own request shape (see
 * {@link P4GraphLoadOptions}), because the extension resolves it with the very
 * function that serves the listing, so the two cannot drift apart.
 *
 * Passed to a get so it can be trusted to know where it landed WITHOUT asking
 * the server: a row exists because that changelist touched something inside this
 * scope, so a get whose scope covers it must land exactly on this changelist
 * (see {@link P4GraphSyncRequest.listScope}).
 */
export type P4GraphListScope = Pick<P4GraphLoadOptions, 'scopePaths' | 'wholeRepo'>

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
   * The scope the listing this row came from was filtered by — NOT this get's
   * scope, even though a row menu passes the same paths for both. They part ways
   * in the multi-directory dialog, which picks a NEW selection that can be
   * NARROWER than the listing: that row's changelist may never have touched the
   * picked directory, so recording it would badge a row this scope never synced
   * (the over-report the whole feature is built to avoid).
   *
   * Present = "the row really is from a listing filtered by this scope"; the
   * extension then re-resolves it and records the row's changelist with no
   * read-back, but ONLY once it has checked that this get's scope covers it.
   * Absent = nothing can be established, and the get falls back to asking p4
   * (correct, just slower) — never to guessing.
   */
  listScope?: P4GraphListScope
  /**
   * The client the rows came from — the graph's `clientRoot` from its own load
   * result. Checked against the client this get resolves to: after the graph
   * switches client, rows loaded from the old one must not have their
   * changelists recorded against the new one's scope.
   */
  clientRoot?: string
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
  /**
   * Force the get (`p4 sync -f`): re-fetch files Perforce already considers
   * current, overwriting writable local copies. Destroys uncollected local work,
   * so the extension always confirms — this flag can only *escalate* what the
   * user is warned about, never waive a warning.
   */
  force?: boolean
}

/**
 * Contributed-command ids the `perforce` extension registers for the Perforce
 * Graph view. Kept here as the single source of truth for the renderer side.
 * All are read-only except `syncToChange`, which mutates the workspace's have
 * revisions (a `p4 sync`) but never the depot; with `force` it is destructive
 * to local files, not just to the workspace's have state.
 */
export const PerforceGraphCommands = {
  getRepos: 'perforce-graph.getRepos',
  setRepo: 'perforce-graph.setRepo',
  getChanges: 'perforce-graph.getChanges',
  getHaveChange: 'perforce-graph.getHaveChange',
  getSyncPoint: 'perforce-graph.getSyncPoint',
  getChangeDetails: 'perforce-graph.getChangeDetails',
  getPendingChanges: 'perforce-graph.getPendingChanges',
  openFileDiff: 'perforce-graph.openFileDiff',
  openWorkingTreeFile: 'perforce-graph.openWorkingTreeFile',
  syncToChange: 'perforce-graph.syncToChange',
  getSyncScopes: 'perforce-graph.getSyncScopes',
} as const

export type PerforceGraphCommandId =
  (typeof PerforceGraphCommands)[keyof typeof PerforceGraphCommands]
