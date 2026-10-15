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
 * - `p4Calls` counts p4 COMMAND PROCESSES this get started, split by which side
 *   started them: `native` are the ones the editor spawned itself, `p4delta` the
 *   ones the δ engine reported spawning internally (charset `p4 set`, client /
 *   fstat / have queries, the transfer). It is NOT a count of server log lines
 *   (a `p4 set` may stay local; `--parallel` transmits over one process) and not
 *   a count of δ invocations. Absent = the record predates this field; when
 *   present, `complete: false` means at least the δ side is a LOWER BOUND (its
 *   run ended without a valid summary), so only the native number is exact.
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
 * How many p4 command processes this get started, split by origin.
 *
 * `native` = processes the editor spawned itself for the run (a native get, or
 * the native fallback δ handed back). `p4delta` = processes the δ engine
 * reported starting inside its own run. A δ run with no fallback therefore has
 * `native: 0` and a nonzero `p4delta`.
 *
 * `complete: false` means the δ side could not be confirmed final (its run
 * ended without a valid summary — killed, cancelled, crashed, or an engine that
 * predates the count), so `p4delta` is a lower bound. The native side is always
 * exact: it is counted from spawn events. Never render an incomplete total as an
 * exact number.
 */
export interface P4SyncCallCountsDto {
  readonly native: number
  readonly p4delta: number
  readonly complete: boolean
  /**
   * δ 侧的分类账：p4 命令类别 → 次数（`set` / `have` / `fstat` / `opened` /
   * `ignores` / `add` / `edit` / `delete` / `revert` / `where` / `sync` /
   * `reconcile` / `clean` / `info` / `client`），只出现非零项。
   *
   * 缺席 = **未采集**（这台机器上的 δ 是旧版本，不上报 `p4CallsByCommand`），渲染成
   * 「未采集」而**绝不是 0 次调用**。它是否完整由 `p4deltaByCommandComplete` 单独说明，**不
   * 跟 `complete` 绑定**：一次运行可能总数确数（`complete: true`）而分类仍是下界（老引擎只发
   * 总数，分类退回事件流上已观测到的那一份）。只描述 δ 侧：原生那一半是编辑器自己起的一条命令。
   */
  readonly p4deltaByCommand?: Readonly<Record<string, number>>
  /**
   * `p4deltaByCommand` 是否是一份**完整**的分类账，与 `complete`（总数是否确数）**相互独立**：
   * `true` = 来自一次通过验证的 summary 分类；`false` = 它是下界（summary 缺席、分类残缺/非法、
   * 或分类来自事件流）。缺席（字段不存在）= 与 `p4deltaByCommand` 同类，渲染成未采集/下界，
   * 绝不冒称完整。
   */
  readonly p4deltaByCommandComplete?: boolean
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
  /** p4 command processes this run started, split native / δ. Absent = the
   *  record predates the field; `complete: false` = the δ side is a lower
   *  bound. Never render an incomplete total as exact. */
  readonly p4Calls?: P4SyncCallCountsDto
  /**
   * The δ engine's log file for this run, as an opaque id — the record's own
   * reference, NOT an argument for `openLog`: that command takes the HISTORY
   * record's id (`id`) and reads this reference off the record, so the renderer
   * never hands a run reference (let alone a path) to the log store.
   *
   * Absent when δ never ran for this get (a pure native one, or one δ refused
   * before spawning) — and also on records written before this field existed.
   * That second case is why an absent reference is not evidence that δ did not
   * run, and why `openLog` words its refusal neutrally. What it is not: "the log
   * was already cleaned up" — that is what `openLog` reports after finding the
   * reference and failing to read it.
   */
  readonly deltaRunId?: string
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
 * history page. All are read-only, answer from a local JSON file (plus, for
 * `openLog`, one bounded read of the δ run log), and make zero p4 calls.
 *
 * - `getRuns(options?: P4SyncHistoryLoadOptions) -> P4SyncHistoryLoadResult`
 * - `getRun(id: string) -> P4SyncRunDetailDto | null`
 * - `openLog(historyId: string) -> P4SyncLogOpenResult`
 *
 * `getRun` answers `null` for "this history has no such record". The host must
 * keep that apart from `undefined`, which is what an UNREGISTERED command id
 * resolves to: that is the only signal it gets for "there is no perforce
 * extension here" (the extension registers these after its activation gates),
 * and rendering one as the other would blame a rotated-out record for a
 * missing extension.
 *
 * `openLog` takes a HISTORY RECORD id and nothing else — never a path. The
 * extension reads the run reference off that record, checks it against its own
 * run-file naming and reads from the fixed log directory, so the renderer cannot
 * reach an arbitrary file. A record with no run reference answers `unknown-run`
 * rather than falling back to the newest log on disk. It answers what happened
 * instead of failing silently: the caller is a button whose whole job is to say
 * why nothing opened.
 */
export const PerforceSyncHistoryCommands = {
  getRuns: 'perforce-sync-history.getRuns',
  getRun: 'perforce-sync-history.getRun',
  openLog: 'perforce-sync-history.openLog',
} as const

/** What `openLog` did. `active` = the run was still writing, so the document is
 *  a snapshot that may grow. */
export type P4SyncLogOpenResult =
  | { readonly ok: true; readonly active: boolean; readonly truncated: boolean }
  /** No δ run could be resolved for what the caller named: no such history
   *  record, a record that predates the run reference, or a get that never ran
   *  δ. The three are one answer because they cannot be told apart from the
   *  outside — which is why the caller's message must not claim δ never ran. */
  | { readonly ok: false; readonly reason: 'unknown-run' }
  /** The run is known but its log is not on disk (cleaned up, or never written). */
  | { readonly ok: false; readonly reason: 'log-missing' }
  /** No log storage in this install (no global storage path). */
  | { readonly ok: false; readonly reason: 'no-storage' }

export type PerforceSyncHistoryCommandId =
  (typeof PerforceSyncHistoryCommands)[keyof typeof PerforceSyncHistoryCommands]
