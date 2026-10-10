/**
 * Perforce sync-history wire types, shared by the renderer (which calls the
 * commands) and, structurally, by the `perforce` extension (which implements
 * them — the extension aliases these shapes with `import type`, which esbuild
 * erases, so this package is never bundled into it).
 *
 * Data crosses the contributed-command boundary as plain JSON: the renderer
 * calls `commands.executeCommand(PerforceSyncHistoryCommands.*, ...)` and the
 * `perforce` extension's handler returns one of the DTOs below.
 *
 * One record per get the editor ran — including cancelled, failed and
 * up-to-date runs, which the graph's sync ledger deliberately does NOT record
 * (see `extensions/perforce/docs/sync-history.md`). `scope` entries are host
 * paths plus directory-ness, never p4 filespecs.
 *
 * Field semantics that the UI must not paper over:
 * - `io` is a process read/write byte count (Linux `rchar`/`wchar`, Windows
 *   `GetProcessIoCounters`), an approximation of network receive + local disk
 *   write, NOT a strict network/disk split. Absent means no sampler was
 *   available for this run (macOS, no WMI, a sampler that died) — render
 *   "unavailable", never 0.
 * - `diskWrites` is a LOWER BOUND from the renderer's file watcher (each push
 *   is truncated at 5000 events and `files.watcherExclude` applies), and 0 can
 *   also mean there is no watcher at all. Render it as "≥N".
 */

/** Where a get was started from. */
export type P4SyncTriggerDto =
  | 'statusBar'
  | 'explorer'
  | 'graph'
  | 'timeline'
  | 'command'
  | 'recovery'

/** How a get ended. `declined` = the user refused at the scope gate, so it never ran. */
export type P4SyncOutcomeDto =
  | 'applied'
  | 'upToDate'
  | 'unrecognized'
  | 'failed'
  | 'cancelled'
  | 'declined'

/** The get engine that served the run. */
export type P4SyncEngineDto = 'p4delta' | 'p4'

/** The six per-file counts of a run (see `SyncRunSummary` in the extension). */
export interface P4SyncCountsDto {
  /** Files updated/added/deleted on disk. */
  readonly applied: number
  /** Per-file refusals: locally modified, uncollected work. */
  readonly refusedModified: number
  /** Per-file refusals: an untracked file already sits at the target path. */
  readonly refusedOverwrite: number
  /** Skipped because the file is open for edit. */
  readonly keptOpen: number
  /** Files p4 says need a resolve first. */
  readonly mustResolve: number
  /** Files δ handed to native p4 as a batch (per-file outcome unknown). */
  readonly handoff: number
}

/** One host-path entry of a run's scope. */
export interface P4SyncRunScopeDto {
  readonly path: string
  readonly isDirectory: boolean
}

/**
 * One run, as the history page's list row — and the base of the detail DTO.
 *
 * `scopeFirst` carries only the first few entries so a 200-row page stays
 * small; `scopeCount` is the full size (including any omitted by the
 * extension-side per-entry cap), so the UI can say "…and N more" without a
 * second round trip. Call `getRun` for the full list.
 */
export interface P4SyncRunDto {
  /** Stable id for `getRun` — `${at}-${pid}-${seq}`. */
  readonly id: string
  /** When the run settled (epoch ms); the list's sort key. */
  readonly at: number
  readonly startedAt: number
  readonly durationMs: number
  /** Client root the get ran against. */
  readonly clientRoot: string
  /** The revision suffix as it was passed to p4: `#head`, `@4521`, `#4`,
   *  `@2026/08/01`, or `''` for a per-file get. Never re-derived. */
  readonly spec: string
  readonly force: boolean
  readonly trigger: P4SyncTriggerDto
  readonly outcome: P4SyncOutcomeDto
  readonly engine?: P4SyncEngineDto
  /** True when δ was attempted and handed this run to native p4. */
  readonly engineFallback?: boolean
  /** `perforce.syncParallelThreads` in force for this run (0 = serial).
   *  Not applicable to δ runs — the UI should say so rather than show the
   *  number. Absent together with `engine`: the run never spawned p4 (declined
   *  at the scope gate). */
  readonly parallelThreads?: number
  readonly counts?: P4SyncCountsDto
  /** Absent = no sampler for this run; never render as 0. */
  readonly io?: { readonly readBytes: number; readonly writeBytes: number }
  /** Lower bound (watcher events); render as "≥N". Absent = nothing was
   *  observed for this run (declined at the scope gate). */
  readonly diskWrites?: number
  readonly error?: { readonly kind: string; readonly message: string }
  /** The scope gate narrowed the user's selection to the daily scope. */
  readonly scopeNarrowed: boolean
  readonly scopeFirst: readonly P4SyncRunScopeDto[]
  /** Full scope size: `scopeFirst.length` only when nothing was omitted. */
  readonly scopeCount: number
}

/** One run with its complete scope — the history page's detail payload. */
export interface P4SyncRunDetailDto extends P4SyncRunDto {
  readonly scope: readonly P4SyncRunScopeDto[]
  /** Scope entries dropped by the extension's per-entry cap, never shown. */
  readonly scopeOmitted: number
}

/** Argument for `getRuns`. */
export interface P4SyncHistoryLoadOptions {
  /** Page size, default 50; the extension clamps it to its own record cap. */
  readonly max?: number
  /** Only runs of this client root (host path); omit for every client. */
  readonly root?: string
}

export interface P4SyncHistoryLoadResult {
  readonly runs: readonly P4SyncRunDto[]
  /** Matching runs in total (before the page cut) — the "N runs" counter. */
  readonly total: number
  readonly hasMore: boolean
}

/**
 * Contributed-command ids the `perforce` extension registers for the sync
 * history page. Both are read-only, answer from a local JSON file, and make
 * zero p4 calls.
 *
 * - `getRuns(options?: P4SyncHistoryLoadOptions) -> P4SyncHistoryLoadResult`
 * - `getRun(id: string) -> P4SyncRunDetailDto | null`
 *
 * `getRun` answers `null` for "this history has no such record". The host must
 * keep that apart from `undefined`, which is what an UNREGISTERED command id
 * resolves to: that is the only signal it gets for "there is no perforce
 * extension here" (the extension registers these after its activation gates),
 * and rendering one as the other would blame a rotated-out record for a
 * missing extension.
 */
export const PerforceSyncHistoryCommands = {
  getRuns: 'perforce-sync-history.getRuns',
  getRun: 'perforce-sync-history.getRun',
} as const

export type PerforceSyncHistoryCommandId =
  (typeof PerforceSyncHistoryCommands)[keyof typeof PerforceSyncHistoryCommands]
