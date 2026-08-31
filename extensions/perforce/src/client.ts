/**
 * One Perforce client (workspace) surfaced through the SCM API. Owns the
 * SourceControl, a dynamic set of changelist ResourceGroups (default + numbered),
 * and the refresh orchestration. Analogous to git's Repository, but the model is
 * different (see design §2): groups are dynamic (one per changelist), state lives
 * on the server (no FS watcher), and refresh is an explicit metadata query.
 *
 * Connection / login state is tracked so the provider can go "offline" (clear
 * groups, drop the count) without spamming errors when the server is unreachable
 * or the session expired.
 */
import {
  commands,
  scm,
  window,
  type Command,
  type Disposable,
  type QuickPickItem,
  type SourceControl,
  type SourceControlResourceGroup,
  type SourceControlResourceState,
  type SourceControlSupplementaryDecoration,
} from '@universe-editor/extension-api'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConcurrencyGate } from './concurrency.js'
import {
  INTERACTIVE_CONTENT_EXEC,
  INTERACTIVE_EXEC,
  P4Service,
  chunkByLength,
  type P4Connection,
  type P4ExecOptions,
  type P4ExecResult,
} from './p4Service.js'
import {
  discoverClient,
  connectionFor,
  parseClientsList,
  type DiscoveredClient,
  type P4ClientEntry,
} from './clientDiscovery.js'
import { parseOpened, parsePending, filterOpenedByOthers } from './openedParser.js'
import {
  groupChangelists,
  countOpened,
  changelistIdFromGroupId,
  descriptionFirstLine,
  shelvedGroupId,
  RECONCILE_GROUP_ID,
  RESOLVE_GROUP_ID,
  type PendingChangelist,
  type P4Action,
} from './changelist.js'
import {
  toResourceStates,
  toShelvedResourceStates,
  toReconcileResourceStates,
} from './p4Decoration.js'
import { parseShelved, type ShelvedFile } from './shelveParser.js'
import { parseFstat, type FstatInfo } from './fstatParser.js'
import { parseFilelog, type FilelogRevision } from './filelogParser.js'
import { parseIgnores } from './ignoresParser.js'
import {
  parseReconcile,
  mergeReconcile,
  filterDismissed,
  expandDismissPaths,
  type ReconcileFile,
} from './reconcileParser.js'
import { norm, isUnderAny, scopeKey } from './pathUtil.js'
import {
  parseSyncOutput,
  parseSyncPreview,
  parseSyncPreviewTotal,
  parseSyncRefused,
  parseResolveOutput,
  type SyncPreviewFile,
  type SyncRunSummary,
} from './syncParser.js'
import { buildNewChangeSpec, replaceDescription, parseDescription } from './changeSpec.js'
import { parseAnnotate, buildBlameResult, type P4BlameResult } from './blameSource.js'
import {
  parseChangesList,
  parseChangeDescribe,
  parseWhereLocalPaths,
  statusFromAction,
  displayPath,
  type GraphChangeMeta,
  type GraphDescribe,
} from './p4GraphParser.js'
import { BaselineProvider } from './baselineProvider.js'
import {
  P4Cache,
  P4CacheNs,
  registerP4CacheNamespaces,
  type P4CacheDiskBackend,
} from './p4Cache.js'
import {
  classifyP4Error,
  classifySyncError,
  notifyP4Failure,
  p4ErrorText,
  type P4FailureKind,
  type SyncErrorKind,
} from './p4Error.js'
import { localize } from './nls.js'

/** A group the SCM view should show this refresh: opened or shelved. Fed to
 *  {@link PerforceClient._applyGroups} which reconciles it against live groups. */
interface DesiredGroup {
  readonly id: string
  readonly label: string
  readonly hideWhenEmpty: boolean
  readonly states: SourceControlResourceState[]
  /** Id of the changelist group this one nests under (shelved files under their
   *  owning changelist), or undefined for a top-level group. */
  readonly parentId?: string
}

export type ConnectionState = 'connected' | 'offline' | 'not-logged-in'

export interface ClientStatus {
  readonly clientName: string
  readonly connection: ConnectionState
  /** Files currently open across all changelists (the SCM badge count). */
  readonly openedCount: number
  /** Files discovered as diverged-but-not-opened (the reconcile group size). */
  readonly reconcileCount: number
  /**
   * Files the server has newer revisions of than this client holds — "you are
   * behind by N". Undefined until the first behind-check completes, which is
   * distinct from `0` ("checked, nothing to get"): the status bar shows nothing
   * for undefined rather than a reassuring zero it hasn't earned.
   */
  readonly syncBehindCount: number | undefined
  /** Whether {@link syncBehindCount} passed the decoration cap (the count is a
   *  floor, not a total — the status bar renders it as "500+"). */
  readonly syncBehindCapped: boolean
  /** Label of a long-running p4 operation in flight (e.g. "Submitting"), or
   *  undefined when idle. Drives the status-bar spinner. */
  readonly busy: string | undefined
  /** Whether the in-flight operation can be cancelled ({@link PerforceClient.cancelBusy}),
   *  so the status bar can offer it as a click action. */
  readonly busyCancellable: boolean
}

export interface P4CacheOptions {
  readonly enabled: boolean
  readonly workspaceTtlMs: number
  readonly disk?: P4CacheDiskBackend
  /** Injectable clock for TTL logic; defaults to `Date.now`. Tests advance it. */
  readonly now?: () => number
}

/** Persisted snapshot of the "changes to reconcile" group: the last discovered
 *  file list plus the set of permanently dismissed (normalized) local paths. */
export interface ReconcilePersistState {
  readonly files: readonly ReconcileFile[]
  readonly dismissed: readonly string[]
}

/** Persistence adapter for the reconcile group, backed by the extension's
 *  `workspaceState` Memento in production (see extension.ts). Injected into the
 *  client so it never depends on the whole ExtensionContext; tests pass an
 *  in-memory stub, and omitting it entirely disables persistence (no-op). */
export interface ReconcileStore {
  load(): ReconcilePersistState
  save(state: ReconcilePersistState): void
}

const SPREADSHEET_EXTS = ['.xlsx', '.xls', '.xlsm', '.csv']

/**
 * Per-command cap for the shelved-file lookup (`describe -S -s <cl>`). Even
 * without diffs, `describe` lists every file in the changelist, so a giant
 * branch changelist emits GB of output and effectively never returns (measured
 * >3min — the same trap that once wedged blame). We only reach this command for
 * changelists that actually report a shelf, and a tight cap keeps one pathological
 * changelist from eating the generous global `perforce.commandTimeout` budget while
 * the user waits on a refresh.
 */
const SHELVED_DESCRIBE_TIMEOUT_MS = 30_000

/**
 * Above this many paths, a mutation clears every ttl cache namespace instead of
 * invalidating per file. Per-file invalidation walks each namespace's keys per
 * needle, so for a bulk operation (a whole changelist revert) the full clear is
 * both cheaper and no less correct.
 */
const MAX_FILE_SCOPED_INVALIDATIONS = 64

/**
 * Above this many surviving reconcile candidates, the cheap path's disk re-verify
 * is skipped instead of fanning dozens of `reconcile -n` batches through the
 * ConcurrencyGate. The opened-set filter still runs; the skipped tail converges
 * via file-watcher incrementals and an explicit Clean Refresh.
 */
const RECONCILE_REVERIFY_MAX_PATHS = 1500

/**
 * Above this many behind files, the grey ↓ markers are dropped and only the
 * count survives. Rendering ten thousand Explorer decorations helps nobody, and
 * the status-bar number stays exact either way — but the skip is always logged,
 * never silent, or the empty Explorer reads as "I'm up to date".
 */
const SYNC_PREVIEW_MAX_DECORATIONS = 500

/**
 * Floor between two behind-checks. Even with the cheap gate in front, the check
 * must not run once per save — the interval is the outer guard, the re-entry flag
 * only stops overlap.
 */
const SYNC_PREVIEW_MIN_INTERVAL_MS = 30_000

/**
 * Hard ceiling on the expensive `sync -n` pass.
 *
 * Measured on a 450k-file game workspace: `sync -n -m 501` over the client root
 * produces **zero bytes in 120s** — `-m` caps how many records come back, not how
 * much of the client view the server walks. Without this ceiling a background
 * behind-check would hold a ConcurrencyGate slot for the full 600s command budget,
 * which is precisely the "shared FIFO gate flooded → clicks queue for minutes"
 * pathology this extension already had to fix once.
 *
 * A behind count is a nicety; a responsive editor is not. Timing out here loses
 * the per-file markers for this round and nothing else.
 */
const SYNC_PREVIEW_TIMEOUT_MS = 20_000

/**
 * Tight ceiling on the cheap gate. Measured at ~130ms even at client-root scope, so
 * ten seconds is two orders of magnitude of headroom: if it hasn't answered by then
 * it is hung, not slow, and the caller should fall through to the real check rather
 * than wait. Same reasoning as the credential-probe timeout.
 */
const SYNC_PREVIEW_GATE_TIMEOUT_MS = 10_000

/**
 * Gate marker standing for "this scope has no submitted changes at all". A real
 * marker is a changelist id list, so this can never collide with one; it exists so
 * that state is comparable across checks instead of being indistinguishable from
 * "the gate told us nothing".
 */
const GATE_MARKER_NO_CHANGES = 'none'

/**
 * Above this many files opened by others, the grey ✎ markers are
 * dropped and only the count survives. Same reasoning as the behind-check cap —
 * but smaller, because "in use by others" is a per-file warning the user acts on
 * one file at a time, and the skip is always logged, never silent.
 */
const OPENED_BY_OTHERS_MAX_DECORATIONS = 300

/**
 * Floor between two opened-by-others scans. Kept separate from the behind-check
 * floor: the two scans answer different questions and change at different rates
 * (an open set churns far more often than a submitted changelist does).
 */
const OPENED_BY_OTHERS_MIN_INTERVAL_MS = 30_000

/**
 * Hard ceiling on the `p4 opened -a` pass.
 *
 * Unlike `sync -n`, `opened` reads the open table (db.opened) instead of walking
 * the client view, so its cost scales with how many files are open anywhere
 * rather than with workspace size — it has no 450k-file-workspace pathology, and
 * there is no changes-table signal a cheap gate could use either. What stays
 * unbounded is the reply on a busy shared server (`-m` bounds the records, not
 * the table scan), so the ceiling stays tight: a timed-out scan loses this
 * round's markers and nothing else, while a hung one would otherwise hold a
 * background ConcurrencyGate slot for the full 600s command budget.
 */
const OPENED_BY_OTHERS_TIMEOUT_MS = 20_000

/**
 * Hard ceiling on the `p4 fstat -Ru //...` unresolved probe inside refresh.
 *
 * Measured on a 450k-file workspace with nothing open: 1165ms. `-Ru` walks the
 * opened/have table (like `opened -a`, ~850ms) instead of the client view, so
 * there is no giant-workspace pathology, and it only runs when something is
 * open at all — the zero-opened refresh skips it entirely. 20s (the same
 * ceiling as the opened-by-others scan, which reads the same table) is two
 * orders of magnitude past the measured normal; a timed-out probe keeps the
 * previous unresolved set, which costs a stale badge at worst, never a wrong
 * "nothing to resolve".
 */
const FSTAT_UNRESOLVED_TIMEOUT_MS = 20_000

/**
 * Hard ceiling on a `p4 ignores -i` batch and the `fstat` depot filter that
 * follows it. Both batches are already capped by `chunkByLength`, so their cost
 * does not grow with the data set — a batch that hasn't answered in 20s is
 * hung, not slow (the same "we can assert how fast it should be" reasoning as
 * the opened-by-others / unresolved-probe ceilings).
 */
const CHECK_IGNORE_TIMEOUT_MS = 20_000

/**
 * What the reconcile stage of a refresh actually did, so the per-stage timing
 * label stays honest: a skipped re-verify must never log as "deferred".
 * `none` = zero reconcile p4 work (discovery off, or no surviving candidates).
 */
type ReconcileOutcome = 'scanned' | 'deferred' | 'skipped' | 'none'

const RECONCILE_STAGE_LABELS: Record<ReconcileOutcome, string> = {
  scanned: 'reconcile',
  deferred: 'reconcile(deferred)',
  skipped: 'reconcile(skipped)',
  none: 'reconcile(none)',
}

/** What a `p4 sync` run reports back — see {@link PerforceClient.sync}. */
export interface SyncRunResult {
  readonly ok: boolean
  readonly cancelled: boolean
  readonly summary: SyncRunSummary | undefined
  /**
   * The files an `allwrite noclobber` client refused because they hold
   * uncollected local work (`summary.refusedModified` is their count). Carried
   * out so the caller can offer to diff them: the refusal already names every
   * path, and re-deriving them with a second p4 call would be both slower and
   * free to disagree with the run the user is being told about.
   */
  readonly refusedFiles: readonly SyncPreviewFile[]
  readonly error: { kind: SyncErrorKind; suggestion: string } | undefined
}

/** True when a path is a spreadsheet the Excel extension should diff in a webview. */
function isSpreadsheetPath(path: string): boolean {
  const lower = path.toLowerCase()
  return SPREADSHEET_EXTS.some((ext) => lower.endsWith(ext))
}

/** First non-empty stderr line — p4's per-file refusal reason, used as the
 *  human-facing `skipped`/`keptOpen` cause. */
function firstStderrLine(stderr: string): string | undefined {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

function sameScopeDirs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((dir, i) => scopeKey(dir) === scopeKey(b[i] ?? ''))
}

/**
 * Normalize a caller-supplied scope into the directories a p4 scan should cover:
 * trailing separators stripped, case-insensitive duplicates collapsed, and any
 * directory nested under another dropped (the shallower one already covers its
 * files, and an overlap would make p4 visit them twice).
 *
 * Keyed via {@link scopeKey} so `Client` and `client` are one entry on Windows —
 * two survivors differing only by case would each look nested under the other
 * and both get dropped, silently widening the scan back to the whole client.
 *
 * Shared by the reconcile and sync scopes; pure.
 */
function normalizeScopeDirs(paths: readonly string[]): string[] {
  const trimmed = paths.map((p) => p.replace(/[/\\]+$/, ''))
  const seen = new Set<string>()
  const unique: string[] = []
  for (const dir of trimmed) {
    const key = scopeKey(dir)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(dir)
  }
  return unique.filter((dir) => !unique.some((other) => other !== dir && isUnderAny(dir, [other])))
}

/** Coerce the `readonly string[] | string | undefined` a scope setter accepts
 *  into a plain list. */
function asScopeList(localPaths: readonly string[] | string | undefined): readonly string[] {
  if (localPaths === undefined) return []
  return typeof localPaths === 'string' ? [localPaths] : localPaths
}

export class PerforceClient {
  private readonly _p4: P4Service
  private readonly _sc: SourceControl
  private readonly _cache: P4Cache
  private readonly _baseline: BaselineProvider
  /** Live groups by group id (default / cl:<n>), so refresh can reuse or drop. */
  private readonly _groups = new Map<string, SourceControlResourceGroup>()
  /** The always-present "changes to reconcile" group (git's untracked/modified
   *  analogue). Created first so it renders at the top; kept out of {@link _groups}
   *  so the reconcile pass owns it and `_applyGroups` never disposes it. */
  private readonly _reconcileGroup: SourceControlResourceGroup
  /** The pinned "needs resolve" group, created second (right below the reconcile
   *  group — the SCM view renders groups in creation order). Same lifecycle rules
   *  as the reconcile group: hidden when empty, never in {@link _groups}, released
   *  in dispose(). */
  private readonly _resolveGroup: SourceControlResourceGroup
  /** Last reconcile discovery (files whose working tree diverged, not yet opened).
   *  Re-filtered against the opened set on every refresh so a just-collected file
   *  drops out without a full re-scan. */
  private _reconcileFiles: readonly ReconcileFile[] = []
  /** Normalized local paths the user permanently dismissed from the reconcile
   *  group ("move out of the list"). Persisted; every list update filters these
   *  out (see {@link _setReconcileFiles}) so a dismissed file never reappears —
   *  even after a Clean Refresh — until it's collected or dismissals are cleared. */
  private _dismissed = new Set<string>()
  /** Normalized client paths currently opened, from the last refresh. Used to
   *  filter incremental (watcher-driven) reconcile scans without a fresh `opened`
   *  round-trip. */
  private _openedPaths: ReadonlySet<string> = new Set()
  /** Normalized client paths the server still reports unresolved, from the last
   *  refresh. The authoritative "what's left to resolve" after a resolve run. */
  private _unresolvedPaths: ReadonlySet<string> = new Set()
  /** Normalized client path → the changelist it's open in ('default' or a numbered
   *  id), from the last refresh. Lets file-scoped shelve resolve which changelist a
   *  clicked row belongs to without another `p4 opened` round-trip. */
  private _changelistByPath: ReadonlyMap<string, string> = new Map()
  /** Opened-file count from the last refresh (mirrors the SCM badge). */
  private _openedCount = 0
  private readonly _changeListeners = new Set<() => void>()
  /** Pending numbered changelists from the last refresh, for reopen quick-picks. */
  private _pending: readonly PendingChangelist[] = []
  private _connection: ConnectionState = 'connected'
  private _refreshing = false
  private _queued = false
  private _inFlightRefresh: Promise<void> | undefined
  /** Serializes reconcile-group mutations against full refreshes. `refresh` and
   *  `refreshReconcilePaths` both read-modify-write the shared reconcile state
   *  (`_reconcileFiles` / `_openedPaths`); without ordering, a watcher-driven
   *  incremental pass that started while a file was still opened can complete
   *  *after* a Move-to-Reconcile pass and clobber the group back to empty (its
   *  own `reconcile -n` saw the file as opened → empty result → merge drops it).
   *  Every pass awaits the previous one on this chain so each sees the last
   *  pass's committed state. */
  private _reconcileChain: Promise<void> = Promise.resolve()
  /** Whether reconcile discovery is on: sticky after the first explicit scan
   *  (clean refresh / collect / file-watch), or always when `perforce.autoReconcile`
   *  is set. When on, the "changes to reconcile" group reflects working-tree drift. */
  private _reconcileActive = false
  /** Whether every refresh should run a full `reconcile -n <scope>` walk. Only set
   *  by `perforce.autoReconcile`; ordinary refreshes re-filter the cached list
   *  instead of walking the tree (see {@link _refreshReconcile}). */
  private _autoReconcile = false
  /** One-shot request for a full reconcile walk on the next refresh (set by a
   *  clean refresh); consumed and cleared inside `_doRefresh`. */
  private _fullScanRequested = false
  /** In-flight background re-verify, so `dispose` and tests can await it. */
  private _backgroundReverify: Promise<void> | undefined
  /** Depot/local scopes (p4 filespecs) the reconcile-discovery pass covers.
   *  Defaults to the whole client (`//...`); narrowed to the workspace focus
   *  folders (or the opened folder) so a huge depot isn't scanned on every
   *  refresh (see {@link setReconcileScope}). */
  private _reconcileScopes: readonly string[] = ['//...']
  /** The same scope as plain local directories, for membership tests. Empty means
   *  the whole-client default — kept separately rather than re-derived from the
   *  filespecs above so the `/...` suffix is never parsed back off. */
  private _reconcileScopeDirs: readonly string[] = []
  /** Filespecs a scope-less `sync` covers. Separate from the reconcile scope on
   *  purpose (see {@link setSyncScope}). */
  private _syncScopes: readonly string[] = ['//...']
  private _syncScopeDirs: readonly string[] = []
  /** In-flight behind-check, so it can't overlap itself and tests can await it. */
  private _backgroundSyncPreview: Promise<void> | undefined
  /** `_now()` of the last behind-check that actually ran p4, for the interval floor. */
  private _lastSyncPreviewAt = 0
  /** Behind count from the last completed check; undefined = never checked. */
  private _syncBehindCount: number | undefined
  /**
   * Whether {@link _syncBehindCount} is the decoration cap rather than a true
   * total. Remembered rather than recomputed so a gate-skipped result reports the
   * same "500+" the scan reported, instead of downgrading it to an exact 500.
   */
  private _syncBehindCapped = false
  /**
   * Highest submitted changelist per sync scope at the last check — the cheap
   * gate's memory. Unchanged marker ⇒ nothing was submitted here ⇒ we cannot have
   * become newly behind, so the expensive pass is skipped entirely.
   */
  private _lastDepotMarker: string | undefined
  /** Whether behind-checks run automatically (`perforce.syncPreview.autoCheck`). */
  private _syncPreviewAutoCheck = false
  /** Configured floor between automatic behind-checks, in ms. */
  private _syncPreviewIntervalMs = SYNC_PREVIEW_MIN_INTERVAL_MS
  /** In-flight opened-by-others scan, so it can't overlap itself and tests can
   *  await it. */
  private _backgroundOpenedByOthers: Promise<void> | undefined
  /** `_now()` of the last opened-by-others scan that actually ran p4, for the
   *  interval floor. */
  private _lastOpenedByOthersAt = 0
  /** Count of files other clients have open, from the last completed scan;
   *  undefined = never scanned. */
  private _openedByOthersCount: number | undefined
  /** Whether {@link _openedByOthersCount} is the decoration cap rather than a
   *  true total. */
  private _openedByOthersCapped = false
  /** Whether opened-by-others scans run automatically
   *  (`perforce.openedByOthers.autoCheck`). */
  private _openedByOthersAutoCheck = false
  /** Configured floor between automatic opened-by-others scans, in ms. */
  private _openedByOthersIntervalMs = OPENED_BY_OTHERS_MIN_INTERVAL_MS
  /**
   * Grey Explorer markers this client currently publishes, keyed by
   * {@link scopeKey}'d local path. Held so the two independent producers — behind
   * files (this phase) and files others have open — can each rewrite their own
   * slice without erasing the other's, then publish the union.
   */
  private readonly _behindDecorations = new Map<string, SourceControlSupplementaryDecoration>()
  /** Grey ✎ markers (files other clients have open), keyed like
   *  {@link _behindDecorations} so {@link _publishSupplementaryDecorations} can
   *  publish the union of both. */
  private readonly _othersDecorations = new Map<string, SourceControlSupplementaryDecoration>()
  private _disposed = false
  private _pollTimer: ReturnType<typeof setInterval> | undefined
  /** Whether Swarm is enabled + configured, so the commit bar offers "Request New
   *  Swarm Review…" as the default submit action. Set from config at activate. */
  private _swarmAvailable = false
  /** Labels of in-flight long-running p4 operations (a stack so overlapping ops
   *  keep the spinner up until the last one finishes). */
  private readonly _busyOps: string[] = []
  /** Abort sources for in-flight cancellable operations (see {@link cancelBusy}). */
  private readonly _cancelSources: AbortController[] = []
  /** Clock shared with the cache, so a test that advances one advances both. */
  private readonly _now: () => number

  private constructor(
    readonly root: string,
    private readonly _clientName: string,
    connection: P4Connection,
    gate: ConcurrencyGate,
    cacheOptions: P4CacheOptions,
    private readonly _log?: (msg: string) => void,
    private readonly _store?: ReconcileStore,
  ) {
    this._p4 = new P4Service(root, gate, connection, _log)
    this._now = cacheOptions.now ?? Date.now
    this._cache = new P4Cache(this._now, cacheOptions.disk, cacheOptions.enabled)
    registerP4CacheNamespaces(this._cache, cacheOptions.workspaceTtlMs)
    this._baseline = new BaselineProvider(this._p4, this._cache)
    this._sc = scm.createSourceControl('perforce', `Perforce: ${_clientName}`, root)
    // Created first so it renders above the changelist groups (SCM view shows
    // groups in creation order). Hidden until reconcile discovery finds drift.
    this._reconcileGroup = this._sc.createResourceGroup(
      RECONCILE_GROUP_ID,
      localize('perforce.group.reconcile', 'Changes to Reconcile'),
    )
    this._reconcileGroup.hideWhenEmpty = true
    // Second, so it renders right below the reconcile group. Same rules as the
    // reconcile group: hideWhenEmpty, never in _groups, disposed separately.
    this._resolveGroup = this._sc.createResourceGroup(
      RESOLVE_GROUP_ID,
      localize('perforce.group.resolve', 'Needs Resolve'),
    )
    this._resolveGroup.hideWhenEmpty = true
    this._sc.inputBox.placeholder = localize(
      'perforce.input.placeholder',
      'Message for the default changelist',
    )
    this._setAcceptInput(false)
  }

  /** Discover the client for `folder` and build a PerforceClient, or undefined
   *  when the folder isn't inside a Perforce workspace. */
  static async create(
    folder: string,
    fallback: P4Connection,
    gate: ConcurrencyGate,
    cacheOptions: P4CacheOptions,
    log?: (msg: string) => void,
    store?: ReconcileStore,
  ): Promise<PerforceClient | undefined> {
    // Connection-less probe first to resolve client + root from the environment.
    const probe = new P4Service(folder, gate, undefined, log)
    let discovered: DiscoveredClient | undefined
    try {
      discovered = await discoverClient(probe, folder, fallback, log)
    } catch {
      // Spawn failed (p4 missing) — surfaced by the caller's guard.
      return undefined
    }
    if (!discovered) return undefined
    return PerforceClient.createForClient(discovered, fallback, gate, cacheOptions, log, store)
  }

  /** Build a client for an already-known client name + root (the
   *  switch-workspace quick-pick), bypassing `p4 info` discovery. The connection
   *  reuses {@link connectionFor}: `-c` is pinned so the cwd's P4CONFIG can't
   *  resolve back to the ambient client, and `-p` is passed ONLY when
   *  `perforce.port` is set explicitly (`p4 info`'s serverAddress is the
   *  server's own bind address, not routable — see clientDiscovery). */
  static createForClient(
    discovered: DiscoveredClient,
    fallback: P4Connection,
    gate: ConcurrencyGate,
    cacheOptions: P4CacheOptions,
    log?: (msg: string) => void,
    store?: ReconcileStore,
  ): PerforceClient {
    const connection = connectionFor(discovered, fallback)
    return new PerforceClient(
      discovered.clientRoot,
      discovered.clientName,
      connection,
      gate,
      cacheOptions,
      log,
      store,
    )
  }

  get status(): ClientStatus {
    return {
      clientName: this._clientName,
      connection: this._connection,
      openedCount: this._openedCount,
      reconcileCount: this._reconcileFiles.length,
      syncBehindCount: this._syncBehindCount,
      syncBehindCapped: this._syncBehindCapped,
      busy: this._busyOps[this._busyOps.length - 1],
      busyCancellable: this._cancelSources.length > 0,
    }
  }

  /**
   * Cancel the in-flight cancellable operation: kills the p4 child, which resolves
   * a failure result the normal error path then handles. Cancelling is a user
   * decision, not a fault, so the caller suppresses the failure toast.
   *
   * Aborts every registered source, since a mutation and its follow-up refresh can
   * both be in flight and leaving one running would keep the spinner up.
   */
  cancelBusy(): void {
    if (this._cancelSources.length === 0) return
    this._log?.('[perforce] cancelling in-flight p4 operation(s) at user request')
    for (const source of this._cancelSources.splice(0)) source.abort()
    this._emitChange()
  }

  /** Run `fn` while a busy label is active (drives the status-bar spinner). The
   *  label is pushed before and popped after, with a change emitted each way so
   *  the status bar shows "<clientName>: <label>…" for the duration. */
  private async _withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this._busyOps.push(label)
    this._emitChange()
    try {
      return await fn()
    } finally {
      const i = this._busyOps.lastIndexOf(label)
      if (i !== -1) this._busyOps.splice(i, 1)
      this._emitChange()
    }
  }

  /**
   * Run `fn` with an abort signal the user can trip via {@link cancelBusy}, and
   * report whether it was cancelled so the caller can skip the failure toast.
   *
   * The source is deregistered in `finally` so a completed operation can't be
   * "cancelled" retroactively.
   */
  private async _cancellable<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; cancelled: boolean }> {
    const source = new AbortController()
    this._cancelSources.push(source)
    this._emitChange()
    try {
      const value = await fn(source.signal)
      return { value, cancelled: source.signal.aborted }
    } finally {
      const i = this._cancelSources.indexOf(source)
      if (i !== -1) this._cancelSources.splice(i, 1)
      this._emitChange()
    }
  }

  /** Subscribe to connection-state changes for the status bar. */
  onDidChange(listener: () => void): Disposable {
    this._changeListeners.add(listener)
    return { dispose: () => this._changeListeners.delete(listener) }
  }

  private _emitChange(): void {
    for (const l of this._changeListeners) l()
  }

  /**
   * Refresh the pending changelists (opened files + numbered CL metadata) and
   * rebuild the groups. Lightweight by default — server metadata queries only.
   *
   * When reconcile discovery is active (after a clean refresh / collect, or with
   * `perforce.autoReconcile`), the "changes to reconcile" group is rebuilt too. A
   * full `p4 reconcile -n` walk only runs when `{ reconcile: true }` forces it (and
   * makes it sticky) — that walk is heavy on a large workspace, so ordinary
   * post-mutation refreshes leave it off. The cheap path re-filters the cached list
   * against the freshly fetched opened set and defers its disk re-verify to the
   * background, so the caller's promise (and the status-bar spinner riding on it)
   * settles once the groups are rebuilt (see {@link _refreshReconcile}).
   * Coalesces concurrent calls.
   */
  async refresh(options?: { reconcile?: boolean }): Promise<void> {
    if (options?.reconcile) {
      this._reconcileActive = true
      this._fullScanRequested = true
    }
    if (this._refreshing) {
      this._queued = true
      // Resolve only once the in-flight pass (which observes the queued flag and
      // runs another round) finishes, so a caller's promise means "the refresh I
      // asked for has actually been served" — the SCM title Refresh button holds
      // its disabled/spinner state for exactly this long.
      await this._inFlightRefresh
      return
    }
    this._refreshing = true
    const run = this._runSerial(async () => {
      try {
        do {
          this._queued = false
          await this._doRefresh()
        } while (this._queued && !this._disposed)
      } finally {
        this._refreshing = false
      }
    })
    this._inFlightRefresh = run
    try {
      await run
    } finally {
      // A new pass may have started (and overwritten the field) between this run
      // settling and the finally running — only clear if it's still ours.
      if (this._inFlightRefresh === run) this._inFlightRefresh = undefined
    }
  }

  /** Serialize a reconcile-state mutation behind any in-flight refresh / reconcile
   *  pass, so each read-modify-write of the shared reconcile state sees the prior
   *  pass's committed result instead of a stale snapshot. A failing task never
   *  breaks the chain for the next one. */
  private _runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = this._reconcileChain.then(task, task)
    this._reconcileChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Turn reconcile discovery on/off (from `perforce.autoReconcile`). Enabling it
   *  makes every subsequent refresh run a full `reconcile -n` walk. */
  setAutoReconcile(enabled: boolean): void {
    this._autoReconcile = enabled
    if (enabled) this._reconcileActive = true
  }

  /** Mark whether Swarm is available (enabled + configured) so the commit bar
   *  offers "Request New Swarm Review…" as the default submit action. Re-renders
   *  the commit actions on the next refresh; call `refresh()` to apply now. */
  setSwarmAvailable(available: boolean): void {
    this._swarmAvailable = available
  }

  /** Narrow the reconcile-discovery scan to the given local directories so a huge
   *  depot isn't walked as `//...` on every refresh. Each directory is passed to
   *  p4 as `<dir>/...` (p4 takes multiple filespecs); a directory nested under
   *  another is dropped, since the shallowest one already covers its files and an
   *  overlap would reconcile them twice. `undefined` or an empty list restores the
   *  whole-client `//...` default.
   *
   *  Re-filters the already-rendered group, so narrowing the scope at runtime
   *  (the focus config changed) drops the now-out-of-scope rows immediately
   *  instead of leaving them until the next refresh. Widening cannot bring rows
   *  back — those need an actual scan, which the next refresh does. */
  setReconcileScope(localPaths: readonly string[] | string | undefined): void {
    const paths = asScopeList(localPaths)
    const previous = this._reconcileScopeDirs
    if (paths.length === 0) {
      this._reconcileScopeDirs = []
      this._reconcileScopes = ['//...']
    } else {
      this._reconcileScopeDirs = normalizeScopeDirs(paths)
      this._reconcileScopes = this._reconcileScopeDirs.map((dir) => `${dir}/...`)
    }
    if (sameScopeDirs(previous, this._reconcileScopeDirs)) return
    if (this._reconcileFiles.length > 0) {
      this._setReconcileFiles(this._reconcileFiles)
      this._emitChange()
    }
  }

  /**
   * Narrow the default `p4 sync` target the same way {@link setReconcileScope}
   * narrows discovery — a game workspace's client root can map far more than the
   * folder the user opened, and "get latest" pulling the whole mapping is both
   * slow and surprising.
   *
   * Kept as its own field rather than reusing the reconcile scope: the two are
   * configured from the same source today (focus folders) but answer different
   * questions, and a future "reconcile only src/ but sync everything" must not
   * require untangling one field into two.
   */
  setSyncScope(localPaths: readonly string[] | string | undefined): void {
    const paths = asScopeList(localPaths)
    const nextDirs = paths.length === 0 ? [] : normalizeScopeDirs(paths)
    if (sameScopeDirs(this._syncScopeDirs, nextDirs)) return
    this._syncScopeDirs = nextDirs
    this._syncScopes = nextDirs.map((dir) => `${dir}/...`)
    // A different scope is a different question: the behind count, its cap
    // flag and the cheap gate's marker all describe the OLD scope. Keeping
    // them would show a stale number, and the marker would make the first
    // check on the new scope skip itself whenever the same changelist happens
    // to be the newest here too — one submit batch landing in several focus
    // dirs is the normal case, so the new scope's count would never appear.
    // Same for the opened-by-others count: it is a claim about the old scope.
    // An UNCHANGED scope (the config-change notification fires for unrelated
    // keys too) clears nothing — that would burn one expensive pass for no
    // new information.
    this._syncBehindCount = undefined
    this._syncBehindCapped = false
    this._lastDepotMarker = undefined
    this._openedByOthersCount = undefined
    this._openedByOthersCapped = false
    if (this._behindDecorations.size > 0 || this._othersDecorations.size > 0) {
      this._behindDecorations.clear()
      this._othersDecorations.clear()
      this._publishSupplementaryDecorations()
    }
    this._emitChange()
  }

  /** The filespecs a scope-less `sync` would target — the configured sync scope
   *  (focus folders) or the whole client mapping. Exposed so a clobber refusal on
   *  a scope-less get can collect exactly the range that get covered, rather than
   *  degrading to a discovery-only refresh that collects nothing. */
  get syncScopes(): readonly string[] {
    return this._syncScopes
  }

  /** Whether a local path falls inside the current reconcile discovery scope.
   *  The whole-client default (no scope dirs) matches everything; a narrowed
   *  scope matches only paths equal to or under one of its directories. */
  private _isInReconcileScope(localPath: string): boolean {
    if (this._reconcileScopeDirs.length === 0) return true
    return isUnderAny(localPath, this._reconcileScopeDirs)
  }

  /**
   * One refresh pass. Each stage is timed into the Perforce output channel: the
   * per-command `> p4 …` / `exit N (Xms)` lines say how long each process took, and
   * these say which stage of the refresh they belonged to — enough to tell "the
   * server is slow" from "we issued too many commands" when a refresh drags.
   */
  private async _doRefresh(): Promise<void> {
    const started = Date.now()
    const stage = (name: string, since: number): number => {
      const now = Date.now()
      this._log?.(`[perforce] refresh/${name} ${now - since}ms`)
      return now
    }
    const opened = await this._p4.execRecords(['opened'])
    if (this._disposed) return
    if (opened.result.exitCode !== 0) {
      this._goOffline(classifyP4Error(opened.result))
      return
    }
    let mark = stage('opened', started)
    const changes = await this._p4.execRecords(['changes', '-s', 'pending', '-c', this._clientName])
    if (this._disposed) return
    if (changes.result.exitCode !== 0) {
      this._goOffline(classifyP4Error(changes.result))
      return
    }

    this._connection = 'connected'
    mark = stage('changes', mark)
    const openedFiles = parseOpened(opened.records, this.root)
    const pending = parsePending(changes.records)
    this._pending = pending

    // Fetch shelved files for the pending changelists that report a shelf, and
    // interleave a shelved sub-group after each owning CL. Changelists without a
    // shelf are never described — see _fetchShelved for why that matters.
    const shelvedByCl = await this._fetchShelved(pending.filter((c) => c.shelved).map((c) => c.id))
    if (this._disposed) return
    mark = stage('shelved', mark)

    // The unresolved signal. Real servers never put `unresolved` in `p4 opened`
    // (PROBE-FINDINGS §11.5) — `fstat -Ru` does, as a bare key. Probing is
    // skipped entirely when nothing is open: with zero opened files there is
    // nothing to be unresolved, and the common refresh stays at zero extra p4
    // work. A failed probe is NOT evidence that nothing is unresolved, so the
    // previous set is kept (same reasoning as runOpenedByOthersScan); an empty
    // successful probe really does mean zero and clears it.
    let keepPreviousUnresolved = false
    let fstatUnresolved: Set<string> | undefined
    if (openedFiles.length > 0) {
      // `//...` is bound by the client view — the same scope `p4 resolve`
      // without a filespec covers. Background priority (refresh fan-out must
      // never take the interactive slot) with the tight ceiling above.
      const fstat = await this._p4.execRecords(['fstat', '-Ru', '//...'], {
        timeoutMs: FSTAT_UNRESOLVED_TIMEOUT_MS,
      })
      if (this._disposed) return
      if (fstat.result.exitCode !== 0) {
        keepPreviousUnresolved = true
        this._log?.(
          `[perforce] fstat -Ru failed (${p4ErrorText(fstat.result)}); keeping the previous unresolved set`,
        )
      } else {
        // fstat's `clientFile` is a LOCAL path (§3 PROBE-FINDINGS) — the one
        // command where it isn't client syntax — so no clientToLocalPath here;
        // `norm` only, exactly like the opened-set keys it merges with.
        fstatUnresolved = new Set(
          parseFstat(fstat.records)
            .filter((i) => i.unresolved && i.clientFile)
            .map((i) => norm(i.clientFile!)),
        )
      }
    }
    mark = stage('unresolved', mark)

    // Final set = what `opened` still reports (defensive: other server versions
    // may carry the key) ∪ the fstat probe ∪, on a failed probe, the previous
    // set. Merging is by normed local path so both sources join on one key.
    const unresolvedPaths = new Set<string>()
    if (keepPreviousUnresolved) {
      for (const p of this._unresolvedPaths) unresolvedPaths.add(p)
    }
    for (const f of openedFiles) {
      if (f.unresolved && f.clientFile) unresolvedPaths.add(norm(f.clientFile))
    }
    if (fstatUnresolved) {
      for (const p of fstatUnresolved) unresolvedPaths.add(p)
    }
    this._unresolvedPaths = unresolvedPaths

    // Mark the opened entries the merged set points at. fstat only hands back
    // paths, so the U rows keep flowing through the OpenedFile chain — row
    // style, contextValue and multi-select arguments all depend on it.
    const markedOpenedFiles = openedFiles.map((f) =>
      f.clientFile && unresolvedPaths.has(norm(f.clientFile)) ? { ...f, unresolved: true } : f,
    )

    const groups = groupChangelists(markedOpenedFiles, pending, {
      default: () => localize('perforce.group.defaultShort', 'Default'),
      numbered: (id, firstLine) =>
        firstLine
          ? localize('perforce.group.numbered', '#{0}: {1}', { 0: id, 1: firstLine })
          : localize('perforce.group.numberedNoDesc', '#{0}', { 0: id }),
    })

    const desired: DesiredGroup[] = []
    for (const group of groups) {
      desired.push({
        id: group.id,
        label: group.label,
        // A pending changelist (default or numbered) stays visible even when empty
        // — matching P4V, where a changelist exists until you delete it. Otherwise a
        // freshly created (still-empty) numbered changelist would vanish, leaving no
        // drop target to move files into.
        hideWhenEmpty: false,
        states: toResourceStates(group.files),
      })
      const clId = changelistIdFromGroupId(group.id)
      const shelved = shelvedByCl.get(clId)
      if (shelved && shelved.length > 0) {
        desired.push({
          id: shelvedGroupId(clId),
          label: localize('perforce.group.shelved', 'Shelved Files'),
          hideWhenEmpty: true,
          states: toShelvedResourceStates(shelved, clId),
          parentId: group.id,
        })
      }
    }

    this._applyGroups(desired)
    this._openedPaths = new Set(
      markedOpenedFiles
        .map((f) => (f.clientFile ? norm(f.clientFile) : undefined))
        .filter(Boolean) as string[],
    )
    // U files also stay in their owning changelist group (like git keeping
    // conflicted files in the working tree) — this pinned group is a shortcut,
    // not a move. Don't "fix" it by removing them from the changelist groups.
    this._resolveGroup.resourceStates = toResourceStates(
      markedOpenedFiles.filter((f) => f.unresolved),
    )
    this._changelistByPath = new Map(
      markedOpenedFiles
        .filter((f) => f.clientFile)
        .map((f) => [norm(f.clientFile!), f.changelist] as const),
    )
    const fullScan = this._fullScanRequested || this._autoReconcile
    this._fullScanRequested = false
    const reconcile = await this._refreshReconcile(fullScan)
    if (this._disposed) return
    stage(RECONCILE_STAGE_LABELS[reconcile], mark)
    this._log?.(`[perforce] refresh total ${Date.now() - started}ms`)
    this._openedCount = countOpened(groups)
    this._sc.count = this._openedCount
    const defaultHasFiles = groups.some((g) => g.isDefault && g.files.length > 0)
    this._setAcceptInput(defaultHasFiles)
    this._emitChange()
    // Fire-and-forget, and deliberately last: the behind-check and the
    // opened-by-others scan are scope-wide server reads, so they must never be
    // part of the refresh the spinner covers. Their own guards decide whether
    // anything actually runs.
    this.scheduleSyncPreview()
    this.scheduleOpenedByOthers()
  }

  /** Wire the commit-bar Submit: enabled only when the default changelist has
   *  files to submit, mirroring git's disabled commit button when empty. */
  private _setAcceptInput(defaultHasFiles: boolean): void {
    this._sc.acceptInputCommand = {
      command: 'perforce.submitDefault',
      title: localize('perforce.command.submit.title', 'Submit'),
      disabled: !defaultHasFiles,
    }
    this._sc.acceptInputActions = defaultHasFiles ? this._buildAcceptActions() : undefined
  }

  /** Commit-bar actions for the default changelist. When Swarm is available, the
   *  primary (default) action is "Request New Swarm Review…", matching P4V's
   *  default; Submit + Revert Unchanged follow. Without Swarm the primary is
   *  Submit. Primary is always first (the view remembers the last-picked one, but
   *  defaults to index 0). */
  private _buildAcceptActions(): Command[] {
    const submit: Command = {
      command: 'perforce.submitDefault',
      title: localize('perforce.command.submit.title', 'Submit'),
      icon: 'check',
    }
    const revertUnchanged: Command = {
      command: 'perforce.revertUnchanged',
      title: localize('perforce.command.revertUnchanged.title', 'Revert Unchanged'),
      icon: 'discard',
    }
    if (this._swarmAvailable) {
      const requestReview: Command = {
        command: 'perforce.swarm.requestReview',
        title: localize('perforce.command.swarm.requestReview.title', 'Request New Swarm Review…'),
        icon: 'git-pull-request',
      }
      return [requestReview, submit, revertUnchanged]
    }
    return [submit, revertUnchanged]
  }

  /**
   * Fetch shelved files for the pending changelists that actually have a shelf,
   * keyed by changelist id. Failures per-CL are logged and skipped so one bad
   * describe doesn't sink the whole refresh.
   *
   * ⚠️ Never fan this out across *every* pending changelist. `describe -S -s`
   * lists all files in a changelist, so one giant branch CL emits GB of output and
   * never returns; a client with many pending changelists then serialized that cost
   * behind the status-bar spinner. Two guards, both required: the caller filters on
   * the `shelved` flag `p4 changes` reports (so we only ask changelists that have a
   * shelf — usually none), and each call carries
   * {@link SHELVED_DESCRIBE_TIMEOUT_MS}. Requests go out concurrently; the
   * ConcurrencyGate bounds how many actually run at once.
   */
  private async _fetchShelved(ids: readonly string[]): Promise<Map<string, ShelvedFile[]>> {
    const out = new Map<string, ShelvedFile[]>()
    if (ids.length === 0) return out
    const fetched = await Promise.all(
      ids.map(async (id) => {
        const res = await this._p4.execRecords(['describe', '-S', '-s', id], {
          timeoutMs: SHELVED_DESCRIBE_TIMEOUT_MS,
        })
        if (res.result.exitCode !== 0) {
          this._log?.(`[perforce] describe -S ${id} failed: ${res.result.stderr.trim()}`)
          return undefined
        }
        return { id, shelved: parseShelved(res.records) }
      }),
    )
    if (this._disposed) return out
    for (const entry of fetched) {
      if (entry && entry.shelved.length > 0) out.set(entry.id, entry.shelved)
    }
    return out
  }

  /**
   * Refresh the "changes to reconcile" group during a full workspace refresh.
   *
   * When discovery is inactive the group is emptied (hidden). With `fullScan` on
   * (clean refresh / `perforce.autoReconcile`) it runs a full `reconcile -n -a -e -d
   * <scope>` walk — heavy on large trees, so only on demand, and never deferred
   * (it's the explicit scan the user asked for). Otherwise (an ordinary
   * post-mutation refresh) it re-filters the cached list against the freshly fetched
   * opened set AND re-verifies each surviving entry against disk with an incremental
   * `reconcile -n` over just those paths — so an entry whose change was discarded
   * (edited back / disk-add deleted / disk-delete restored) drops out without
   * walking the whole tree.
   *
   * The cheap path's opened-set filter happens synchronously (so a just-collected
   * file leaves the group immediately), but the disk re-verify is *always* deferred
   * to the background: re-scanning every other candidate is no reason to make the
   * user wait on an O(1) collect, and those entries are re-verified anyway by the
   * file watcher when they actually change, by the next ordinary refresh, or by a
   * Clean Refresh. Trades a few seconds of a possibly-stale sibling entry for a
   * spinner that tracks the operation the user actually asked for. When the surviving
   * candidate set is huge the background re-verify is skipped outright instead of
   * fanning dozens of `reconcile -n` batches through the ConcurrencyGate (see
   * {@link RECONCILE_REVERIFY_MAX_PATHS}) — the opened-set filter still lands, and
   * the skipped tail converges via the watcher + Clean Refresh.
   *
   * `p4 reconcile -n` is a dry run — it never mutates server state (collecting a
   * file is a separate real `reconcile`). Files already opened are filtered out
   * (their disk edits are tracked in a changelist group). A failed walk logs and
   * clears the group rather than sinking the whole refresh.
   */
  private async _refreshReconcile(fullScan: boolean): Promise<ReconcileOutcome> {
    if (!this._reconcileActive) {
      this._setReconcileFiles([])
      return 'none'
    }
    if (!fullScan) {
      // Cheap path: no whole-tree walk. First drop cached entries that are now
      // opened (e.g. just collected) and commit that filtered list immediately, so
      // a just-collected file leaves the group on this pass. Then re-verify the
      // surviving entries against disk — deferred to the background, or skipped
      // outright when the set is so large the re-verify would flood the
      // ConcurrencyGate (see _scheduleBackgroundReverify / _rescanReconcilePaths).
      const candidates = this._reconcileFiles.filter(
        (f) => !f.clientFile || !this._openedPaths.has(norm(f.clientFile)),
      )
      const paths = candidates.map((f) => f.clientFile).filter((p): p is string => p !== undefined)
      if (paths.length === 0) {
        this._setReconcileFiles(candidates)
        return 'none'
      }
      if (paths.length > RECONCILE_REVERIFY_MAX_PATHS) {
        this._setReconcileFiles(candidates)
        this._log?.(
          `[perforce] reconcile re-verify skipped: ${paths.length} candidates exceed ` +
            `${RECONCILE_REVERIFY_MAX_PATHS}; relying on watcher incrementals + Clean Refresh`,
        )
        return 'skipped'
      }
      this._setReconcileFiles(candidates)
      this._scheduleBackgroundReverify(paths)
      return 'deferred'
    }
    const res = await this._p4.execRecords([
      'reconcile',
      '-n',
      '-a',
      '-e',
      '-d',
      ...this._reconcileScopes,
    ])
    if (this._disposed) return 'scanned'
    if (res.result.exitCode !== 0) {
      // `reconcile -n` exits non-zero with "no file(s) to reconcile" when the
      // tree is clean — that's not an error, just an empty result.
      const stderr = res.result.stderr.toLowerCase()
      const missingScope = stderr.includes('- no such file')
      if (!stderr.includes('no file(s) to reconcile') && !missingScope) {
        this._log?.(`[perforce] reconcile -n failed: ${res.result.stderr.trim()}`)
      }
      // With several focus scopes on one command line, one missing directory
      // makes the whole invocation exit non-zero while p4 still reports the
      // other scopes. Discarding the parsed records would empty the group on
      // every refresh for as long as that directory is gone, so keep whatever
      // came back and only fall through to empty when there is nothing.
      if (missingScope && res.records.length > 0) {
        this._log?.(
          `[perforce] reconcile -n: a scope is missing from the workspace; keeping the rest`,
        )
      } else {
        this._setReconcileFiles([])
        return 'scanned'
      }
    }
    const files = parseReconcile(res.records, this.root).filter(
      (f) => !f.clientFile || !this._openedPaths.has(norm(f.clientFile)),
    )
    this._setReconcileFiles(files)
    return 'scanned'
  }

  /**
   * Run the cheap-path disk re-verify for `paths` after the current refresh has
   * already settled, updating the group silently when it lands.
   *
   * Starts on a macrotask, not just a chained promise: the caller's `await` drains
   * the microtask queue, so chaining alone would still complete inside the awaited
   * window whose duration the spinner reflects. Once released it enters the serial
   * chain like every other reconcile mutation, so it observes the committed state of
   * whatever pass is running and can't clobber a later watcher pass.
   *
   * Deliberately fire-and-forget: nothing awaits the returned promise except
   * {@link whenBackgroundReverifySettled}. The `.catch` is mandatory, not defensive
   * — an unhandled rejection from a floating promise takes down the extension host.
   *
   * Re-entrant calls while one is already in flight are dropped (see the guard).
   */
  private _scheduleBackgroundReverify(paths: readonly string[]): void {
    // If a re-verify is already queued/in flight, drop this request: stacking a new
    // serial pass per refresh would pile up N redundant full rescans behind the
    // ConcurrencyGate. Safe because the discarded path set is a subset of the
    // in-flight one — an ordinary refresh only shrinks the candidate list as
    // `opened` grows, and that opened-set filter has already committed + persisted
    // synchronously. Real file changes aren't lost either: the watcher's incremental
    // path is `refreshReconcilePaths`, which bypasses this guard.
    if (this._backgroundReverify) return
    const run = (async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 0)
        // Never let a deferred re-verify hold the host process open on its own.
        timer.unref?.()
      })
      if (this._disposed) return
      await this._runSerial(async () => {
        if (this._disposed) return
        const { scanned, fresh } = await this._rescanReconcilePaths(paths)
        if (this._disposed) return
        this._setReconcileFiles(mergeReconcile(this._reconcileFiles, scanned, fresh))
        this._emitChange()
      })
    })()
      .catch((err: unknown) => {
        this._log?.(`[perforce] background reconcile re-verify failed: ${String(err)}`)
      })
      .finally(() => {
        if (this._backgroundReverify === run) this._backgroundReverify = undefined
      })
    this._backgroundReverify = run
  }

  /** Await any in-flight background re-verify (tests; also lets callers settle). */
  async whenBackgroundReverifySettled(): Promise<void> {
    await this._backgroundReverify
  }

  /**
   * Incrementally reconcile just the given changed paths (from the file watcher)
   * instead of walking the whole opened folder. Runs `reconcile -n -a -e -d` on the
   * exact paths, merges the result into the cached group (see {@link mergeReconcile})
   * and re-renders — so cost is O(changed files), not O(tree size).
   *
   * Enables discovery (so the group keeps reflecting drift) but never sets the
   * full-scan flag, so it stays cheap. A path that comes back clean drops out; a
   * newly diverged path is added. Safe to interleave with a full refresh — p4
   * calls are serialized and the merge always reads the latest cached list.
   *
   * Already-opened paths are dropped first. Opening a file for edit clears its
   * read-only bit, which the watcher reports as a change — so every collect/checkout
   * echoes back here for a scan whose result is discarded anyway (an opened file is
   * filtered out of the group by all three producers). The filter runs inside the
   * serial task so it reads the `_openedPaths` the last pass committed.
   */
  async refreshReconcilePaths(paths: readonly string[]): Promise<void> {
    if (this._disposed || paths.length === 0) return
    await this._runSerial(async () => {
      if (this._disposed) return
      const relevant = paths.filter((p) => !this._openedPaths.has(norm(p)))
      if (relevant.length === 0) return
      this._reconcileActive = true
      const { scanned, fresh } = await this._rescanReconcilePaths(relevant)
      if (this._disposed) return
      this._setReconcileFiles(mergeReconcile(this._reconcileFiles, scanned, fresh))
      this._emitChange()
    })
  }

  /**
   * Run the incremental `reconcile -n -a -e -d` scan for `paths` and report which
   * paths were actually re-scanned (`scanned`) plus the still-diverged results
   * (`fresh`), for {@link mergeReconcile} to fold into the cached list.
   *
   * Split the paths into command-line-sized batches so a huge set (tens of
   * thousands of files from a busy tree) can't overflow the OS argv limit
   * (Windows `ENAMETOOLONG`); results merge across batches. Only paths from
   * batches that actually completed a scan (clean or with results) count as
   * "re-scanned"; a genuinely failed batch's paths are left out so their prior
   * entries are carried over, not dropped. A batch that comes back clean ("no
   * file(s) to reconcile" / "no such file") is re-scanned and contributes nothing.
   *
   * Batches go out concurrently — the ConcurrencyGate (`perforce.maxConcurrent`)
   * already bounds how many p4 processes actually run, so awaiting them one by one
   * just left that budget idle. Results are folded back **in batch order** because
   * {@link mergeReconcile} preserves the order of `fresh`, which drives the row
   * order in the group; completion order would make it nondeterministic. A batch
   * that throws (spawn failure, e.g. p4 missing) is logged and contributes nothing
   * rather than sinking the whole scan.
   *
   * Deliberately does NOT enter the serial chain or touch shared state — callers
   * own ordering (via {@link _runSerial}) and merging, so it's safe to invoke
   * from inside an already-serialized refresh (the cheap re-verify path).
   */
  private async _rescanReconcilePaths(
    paths: readonly string[],
  ): Promise<{ scanned: string[]; fresh: ReconcileFile[] }> {
    const batches = chunkByLength(paths)
    const perBatch = await Promise.all(
      batches.map(async (batch): Promise<{ scanned: string[]; fresh: ReconcileFile[] }> => {
        const empty = { scanned: [] as string[], fresh: [] as ReconcileFile[] }
        if (this._disposed) return empty
        let res: Awaited<ReturnType<typeof this._p4.execRecords>>
        try {
          res = await this._p4.execRecords(['reconcile', '-n', '-a', '-e', '-d', ...batch])
        } catch (err) {
          this._log?.(`[perforce] incremental reconcile -n could not run: ${String(err)}`)
          return empty
        }
        if (this._disposed) return empty
        if (res.result.exitCode === 0) {
          const fresh = parseReconcile(res.records, this.root).filter(
            (f) => !f.clientFile || !this._openedPaths.has(norm(f.clientFile)),
          )
          return { scanned: [...batch], fresh }
        }
        const stderr = res.result.stderr.toLowerCase()
        if (stderr.includes('no file(s) to reconcile') || stderr.includes('- no such file')) {
          return { scanned: [...batch], fresh: [] }
        }
        this._log?.(`[perforce] incremental reconcile -n failed: ${res.result.stderr.trim()}`)
        return empty
      }),
    )
    const fresh: ReconcileFile[] = []
    const scanned: string[] = []
    for (const batch of perBatch) {
      scanned.push(...batch.scanned)
      fresh.push(...batch.fresh)
    }
    return { scanned, fresh }
  }

  /** Set the reconcile file list and mirror it into the group's resource states.
   *  Every producer (full scan, cheap re-filter, incremental merge, restore)
   *  lands here, so this is the single funnel where the discovery scope is
   *  enforced — a file outside the scope never enters the group, whatever path
   *  reported it, and narrowing the scope drops entries already listed. Dismissed
   *  files are filtered out here too, then the result is persisted so it survives
   *  a reload without a fresh scan. */
  private _setReconcileFiles(files: readonly ReconcileFile[]): void {
    const inScope = files.filter((f) => !f.clientFile || this._isInReconcileScope(f.clientFile))
    const visible = filterDismissed(inScope, this._dismissed)
    this._reconcileFiles = visible
    this._reconcileGroup.resourceStates = toReconcileResourceStates(visible)
    this._persistReconcile()
  }

  /** Mirror the current reconcile list + dismissed set into the injected store
   *  (no-op when no store was provided, e.g. in tests). */
  private _persistReconcile(): void {
    this._store?.save({ files: this._reconcileFiles, dismissed: [...this._dismissed] })
  }

  /**
   * Restore the reconcile group from the persisted snapshot at activation, before
   * the first refresh. Loads the dismissed set and the last-known file list and
   * renders it immediately — so a reload shows the group right away — WITHOUT a
   * `reconcile -n` walk (cheap). Reconcile discovery is turned on (sticky) so the
   * next ordinary refresh re-filters the restored list against the fresh `opened`
   * set (dropping anything already collected) instead of clearing it.
   */
  restoreReconcile(): void {
    if (!this._store) return
    const { files, dismissed } = this._store.load()
    this._dismissed = new Set(dismissed.map(norm))
    if (files.length > 0 || dismissed.length > 0) this._reconcileActive = true
    this._setReconcileFiles(files)
    this._emitChange()
  }

  /** Reconcile the live ResourceGroups with the freshly computed groups: create
   *  new ones, update existing, dispose those that vanished. */
  private _applyGroups(groups: readonly DesiredGroup[]): void {
    const seen = new Set<string>()
    for (const group of groups) {
      seen.add(group.id)
      let live = this._groups.get(group.id)
      if (!live) {
        live = this._sc.createResourceGroup(
          group.id,
          group.label,
          group.parentId !== undefined ? { parentId: group.parentId } : undefined,
        )
        live.hideWhenEmpty = group.hideWhenEmpty
        this._groups.set(group.id, live)
      } else {
        live.label = group.label
      }
      live.resourceStates = group.states
    }
    for (const [id, live] of [...this._groups]) {
      if (!seen.has(id)) {
        live.dispose()
        this._groups.delete(id)
      }
    }
  }

  private _goOffline(kind: P4FailureKind): void {
    this._connection =
      kind === 'session-expired' || kind === 'not-logged-in' ? 'not-logged-in' : 'offline'
    for (const live of this._groups.values()) live.resourceStates = []
    this._reconcileGroup.resourceStates = []
    this._reconcileFiles = []
    this._openedPaths = new Set()
    this._resolveGroup.resourceStates = []
    this._unresolvedPaths = new Set()
    this._openedCount = 0
    this._sc.count = 0
    this._setAcceptInput(false)
    // A behind count is a claim about the server, so it can't outlive the
    // connection: "↓12" while disconnected is a number nothing can refresh.
    this._syncBehindCount = undefined
    this._syncBehindCapped = false
    // "Who has what open" is a claim about the server too, so it goes as well.
    this._openedByOthersCount = undefined
    this._openedByOthersCapped = false
    // The gate's memory has to go with it. Keeping it would let the first check
    // after reconnecting see an unchanged marker, skip the scan, and leave the
    // count blank until someone happens to submit — the cache is only valid as
    // long as the count it was gating still exists.
    this._lastDepotMarker = undefined
    this._behindDecorations.clear()
    this._othersDecorations.clear()
    this._publishSupplementaryDecorations()
    this._log?.(`[perforce] ${this._clientName} → ${this._connection} (${kind})`)
    this._emitChange()
  }

  /** Log in by feeding the password/ticket to `p4 login` via stdin. */
  async login(password: string): Promise<{ ok: boolean; result: P4ExecResult }> {
    const result = await this._p4.exec(['login'], { input: `${password}\n` })
    return { ok: result.exitCode === 0, result }
  }

  async logout(): Promise<{ ok: boolean; result: P4ExecResult }> {
    const result = await this._p4.exec(['logout'])
    return { ok: result.exitCode === 0, result }
  }

  /** The description typed in the SCM input box (used when submitting the
   *  default changelist). */
  get description(): string {
    return this._sc.inputBox.value
  }
  set description(value: string) {
    this._sc.inputBox.value = value
  }

  /**
   * Run a mutating p4 command, surface a toast on failure, and always refresh
   * afterwards so the SCM view reflects the new server state. Returns whether it
   * succeeded. Empty `paths` is a no-op (nothing selected). The post-mutation
   * reconcile re-verify is deferred to the background (see {@link _refreshReconcile}).
   */
  private async _mutate(
    label: string,
    args: readonly string[],
    paths: readonly string[] = [],
  ): Promise<boolean> {
    if (args.length === 0) return false
    return this._withBusy(this._busyLabel(label), async () => {
      const { value: result, cancelled } = await this._cancellable((signal) =>
        this._p4.exec([...args, ...paths], { signal }),
      )
      if (cancelled) {
        // The user asked for this — report it in the log, not as an error toast,
        // and still refresh so the view reflects whatever did land.
        this._log?.(`[perforce] ${label} cancelled by user`)
        await this._refreshAfterMutation()
        return false
      }
      if (result.exitCode !== 0) {
        await notifyP4Failure(label, result)
        await this._refreshAfterMutation()
        return false
      }
      this._invalidateAfterMutation(paths)
      await this._refreshAfterMutation()
      return true
    })
  }

  /** The post-mutation refresh, under its own busy label. The p4 command itself is
   *  done by now, so the status bar should say so instead of leaving the operation's
   *  label up for the whole refresh (`_busyOps` is a stack — the top one shows). */
  private async _refreshAfterMutation(): Promise<void> {
    await this._withBusy(localize('perforce.busy.refresh', 'Refreshing'), () => this.refresh())
  }

  /**
   * Drop the cache entries a just-finished mutation could have staled.
   *
   * A single-file operation only invalidates that file's entries plus the `opened`
   * namespace; a whole-client or bulk operation still clears every ttl namespace.
   * Why the narrow set is sufficient:
   *  - `opened` must always go: its only key is `'all'` (the graph's pending count
   *    and opened list), which no path needle can match.
   *  - `where` / `changeDetailPaths` depend on the client *view*, which a mutation
   *    doesn't change.
   *  - `filelog` / `changesSubmitted` only change on submit/sync, and those
   *    mutations pass no paths → they take the full-clear branch.
   *  - `shelvedDescribe` is keyed by changelist id, and shelve/unshelve likewise
   *    pass no paths → full clear.
   *  - `fstat` is a ttl namespace keyed by `norm(localPath)`, so it's covered by
   *    the `invalidateFile` needles above (and the full-clear branch) — no special
   *    case needed.
   * `invalidateFile` matches by substring, so a needle can over-match a similarly
   * named key; that only costs one extra fetch, never correctness.
   */
  private _invalidateAfterMutation(paths: readonly string[]): void {
    const narrow =
      paths.length > 0 &&
      paths.length <= MAX_FILE_SCOPED_INVALIDATIONS &&
      !paths.some((p) => p.endsWith('/...'))
    if (!narrow) {
      this._cache.invalidateWorkspace()
      return
    }
    for (const p of paths) {
      this._cache.invalidateFile(p)
      const normalized = norm(p)
      if (normalized !== p) this._cache.invalidateFile(normalized)
    }
    this._cache.invalidateNamespace(P4CacheNs.opened)
  }

  /** Human-friendly busy label for a raw p4 command label (e.g. `revert -k` →
   *  "Reverting"). Falls back to a generic "Working" for unmapped commands. */
  private _busyLabel(label: string): string {
    const full: Record<string, string> = {
      'delete changelist': localize('perforce.busy.deleteChangelist', 'Deleting changelist'),
      'delete shelved': localize('perforce.busy.deleteShelved', 'Deleting shelved files'),
      'revert -a': localize('perforce.busy.revert', 'Reverting'),
      'revert -k': localize('perforce.busy.reopen', 'Moving files'),
    }
    if (full[label]) return full[label]!
    const base = label.split(' ')[0] ?? label
    const map: Record<string, string> = {
      edit: localize('perforce.busy.edit', 'Opening for edit'),
      add: localize('perforce.busy.add', 'Opening for add'),
      delete: localize('perforce.busy.delete', 'Opening for delete'),
      revert: localize('perforce.busy.revert', 'Reverting'),
      clean: localize('perforce.busy.revert', 'Reverting'),
      reconcile: localize('perforce.busy.reconcile', 'Collecting changes'),
      submit: localize('perforce.busy.submit', 'Submitting'),
      reopen: localize('perforce.busy.reopen', 'Moving files'),
      shelve: localize('perforce.busy.shelve', 'Shelving'),
      unshelve: localize('perforce.busy.unshelve', 'Unshelving'),
      resolve: localize('perforce.busy.resolve', 'Resolving'),
      change: localize('perforce.busy.change', 'Updating changelist'),
    }
    return map[base] ?? localize('perforce.busy.generic', 'Working')
  }

  /** Open files for edit (checkout). */
  async edit(paths: readonly string[]): Promise<boolean> {
    return this._mutate('edit', ['edit'], paths)
  }

  /** Open files for add (schedule new files for addition). */
  async add(paths: readonly string[]): Promise<boolean> {
    return this._mutate('add', ['add'], paths)
  }

  /** Open files for delete (`p4 delete` marks them for deletion). */
  async delete(paths: readonly string[]): Promise<boolean> {
    return this._mutate('delete', ['delete'], paths)
  }

  /**
   * Collect (reconcile) working-tree changes into open state: run the real
   * `p4 reconcile -a -e -d` on `paths`, which opens each file for the action that
   * matches its on-disk state (add / edit / delete). The file then leaves the
   * "changes to reconcile" group and appears in a changelist group. Enables
   * reconcile discovery so the group keeps reflecting drift afterwards.
   */
  async reconcile(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    this._reconcileActive = true
    this._undismiss(paths)
    return this._mutate('reconcile', ['reconcile', '-a', '-e', '-d'], paths)
  }

  /**
   * Collect working-tree changes straight into a specific changelist
   * (`p4 reconcile -a -e -d -c <cl>`): the "changes to reconcile" analogue of
   * {@link reopen}, used when a reconcile row is dropped onto a changelist group.
   * Unlike {@link reopen} (which only moves *already-opened* files), this opens
   * the not-yet-opened files for their on-disk action directly in `changelist`.
   * `'default'` collects into the default changelist (no `-c`).
   */
  async reconcileInto(changelist: string, paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    this._reconcileActive = true
    this._undismiss(paths)
    const args =
      changelist === 'default'
        ? ['reconcile', '-a', '-e', '-d']
        : ['reconcile', '-a', '-e', '-d', '-c', changelist]
    return this._mutate('reconcile', args, paths)
  }

  /** Collect every currently discovered reconcile candidate at once. */
  async reconcileAll(): Promise<boolean> {
    const paths = this._reconcileFiles
      .map((f) => f.clientFile)
      .filter((p): p is string => p !== undefined)
    if (paths.length === 0) {
      // Nothing discovered yet — run a whole-tree reconcile so "collect all"
      // works even before an explicit scan populated the group.
      this._reconcileActive = true
      return this._mutate('reconcile', ['reconcile', '-a', '-e', '-d', '//...'])
    }
    return this.reconcile(paths)
  }

  /** Revert files — discards the open state and restores the have revision. */
  async revert(paths: readonly string[]): Promise<boolean> {
    return this._mutate('revert', ['revert'], paths)
  }

  /**
   * Revert every open file in a changelist (`p4 revert -c <id> //...`), discarding
   * all its local edits. Destructive — the caller confirms first. `'default'`
   * reverts the default changelist's files.
   */
  async revertChangelist(changelist: string): Promise<boolean> {
    const args =
      changelist === 'default'
        ? ['revert', '-c', 'default', '//...']
        : ['revert', '-c', changelist, '//...']
    return this._mutate('revert', args)
  }

  /**
   * Revert only files that are open but unchanged from the depot (`p4 revert -a`).
   * Scoped to a numbered changelist when `changelist` is a number, otherwise the
   * whole client. Safe (never discards real edits), so no confirmation needed.
   */
  async revertUnchanged(changelist?: string): Promise<boolean> {
    const args =
      changelist && changelist !== 'default'
        ? ['revert', '-a', '-c', changelist, '//...']
        : ['revert', '-a', '//...']
    return this._mutate('revert -a', args)
  }

  /**
   * Submit a changelist. The default changelist needs a description (`-d`);
   * numbered changelists carry their own spec, so submit directly (`-c <id>`).
   * Returns whether the submit succeeded so the caller can clear the input box.
   */
  async submit(changelist: string, description?: string): Promise<boolean> {
    if (changelist === 'default') {
      const desc = (description ?? '').trim()
      if (!desc) return false
      return this._mutate('submit', ['submit', '-d', desc])
    }
    return this._mutate('submit', ['submit', '-c', changelist])
  }

  // --- Numbered changelist management (Phase 3) ----------------------------

  /**
   * Create a new numbered changelist with `description` (empty default group
   * left as-is). Returns the new changelist id, or undefined on failure. Files
   * can then be moved in via {@link reopen}. Uses `p4 change -i` fed a spec.
   */
  async newChangelist(description: string): Promise<string | undefined> {
    const spec = buildNewChangeSpec(description, this._p4.connection)
    const res = await this._p4.exec(['change', '-i'], { input: spec })
    if (res.exitCode !== 0) {
      await notifyP4Failure('new changelist', res)
      return undefined
    }
    // `Change 12345 created.` — pull the id out of stdout.
    const m = /Change (\d+) created/.exec(res.stdout)
    await this.refresh()
    return m?.[1]
  }

  /**
   * Move files into a changelist (`p4 reopen -c <target>`). `target` is a
   * numbered id or 'default'. This is how files migrate between changelist groups
   * in the SCM view.
   */
  async reopen(target: string, paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    const cl = target === 'default' ? 'default' : target
    return this._mutate('reopen', ['reopen', '-c', cl], paths)
  }

  /** The changelist a currently-opened local path belongs to ('default' or a
   *  numbered id), from the last refresh, or undefined if the path isn't open. */
  changelistOf(localPath: string): string | undefined {
    return this._changelistByPath.get(norm(localPath))
  }

  /**
   * Create a new numbered changelist with `description` and move `paths` into it
   * in one step — the common "group these edits into a new changelist" intent,
   * instead of creating an empty changelist and moving files separately. Returns
   * the new changelist id, or undefined on failure.
   */
  async moveToNewChangelist(
    description: string,
    paths: readonly string[],
  ): Promise<string | undefined> {
    const created = await this.newChangelist(description)
    if (!created) return undefined
    if (paths.length > 0) await this.reopen(created, paths)
    return created
  }

  /**
   * Quick-pick targets for {@link reopen}: the default changelist, every pending
   * numbered changelist (from the last refresh), and a "New Changelist" entry
   * (id `'new'`) the command handler expands into a create-then-reopen flow.
   */
  async changelistPicks(): Promise<(QuickPickItem & { id: string })[]> {
    const items: (QuickPickItem & { id: string })[] = [
      { id: 'default', label: localize('perforce.group.default', 'Default Changelist') },
    ]
    for (const cl of this._pending) {
      const firstLine = descriptionFirstLine(cl.description)
      items.push({
        id: cl.id,
        label: `#${cl.id}`,
        ...(firstLine ? { description: firstLine } : {}),
      })
    }
    items.push({
      id: 'new',
      label: localize('perforce.reopen.newChangelist', 'New Changelist…'),
    })
    return items
  }

  /** Read a changelist's current description (from its `change -o` spec). */
  async getChangelistDescription(changelist: string): Promise<string> {
    const res = await this._p4.exec(['change', '-o', changelist])
    if (res.exitCode !== 0) return ''
    return parseDescription(res.stdout)
  }

  /**
   * Replace a numbered changelist's description, preserving its Files list and
   * every other field. Reads the current spec, rewrites the Description block,
   * feeds it back through `p4 change -i`.
   */
  async editChangelistDescription(changelist: string, description: string): Promise<boolean> {
    const current = await this._p4.exec(['change', '-o', changelist])
    if (current.exitCode !== 0) {
      await notifyP4Failure('edit changelist', current)
      return false
    }
    const updated = replaceDescription(current.stdout, description)
    const res = await this._p4.exec(['change', '-i'], { input: updated })
    if (res.exitCode !== 0) {
      await notifyP4Failure('edit changelist', res)
      return false
    }
    await this.refresh()
    return true
  }

  // --- Shelve / unshelve (Phase 3) -----------------------------------------

  /** Local paths of files currently open in `changelist` ('default' or a numbered
   *  id), from the last refresh. Lets the default-changelist shelve flow gather the
   *  files to move into a fresh numbered changelist before shelving. */
  pathsInChangelist(changelist: string): string[] {
    const out: string[] = []
    for (const [path, cl] of this._changelistByPath) {
      if (cl === changelist) out.push(path)
    }
    return out
  }

  /** Shelve a changelist's open files (`p4 shelve -c <id>`), leaving them open.
   *  The default changelist can't be shelved directly (p4 requires a numbered CL);
   *  the command handler moves its files into a fresh numbered CL first. */
  async shelve(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('shelve', ['shelve', '-r', '-c', changelist])
  }

  /** Restore a whole changelist's shelved files into the workspace
   *  (`p4 unshelve -s <id>`), overwriting local copies (`-f`). */
  async unshelve(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('unshelve', ['unshelve', '-s', changelist, '-c', changelist, '-f'])
  }

  /** Restore a single shelved file into the workspace (`p4 unshelve -s <id> <depotFile>`),
   *  overwriting the local copy (`-f`). */
  async unshelveFile(changelist: string, depotFile: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('unshelve', [
      'unshelve',
      '-s',
      changelist,
      '-c',
      changelist,
      '-f',
      depotFile,
    ])
  }

  /**
   * Restore an arbitrary changelist's shelf into the default changelist
   * (`p4 unshelve -s <n> -f`) — for shelves that aren't shown in this workspace's
   * panel (a teammate's, or one made on another machine). Destructive: `-f`
   * overwrites local copies, so the command handler confirms first.
   */
  async unshelveByNumber(changelist: string): Promise<boolean> {
    return this._mutate('unshelve', ['unshelve', '-s', changelist, '-f'])
  }

  /**
   * Restore a SUBSET of a shelved change's files into the default changelist
   * (`p4 unshelve -s <change> -f <depotFile...>`), overwriting local copies.
   * Not a `_mutate`: partial failure is the norm here (p4 refuses files already
   * open for edit, or whose base revision is stale), and the caller needs the
   * structured applied/skipped split rather than a toast + boolean. Falls back
   * to per-file retries when the batch fails so one refused file doesn't take
   * down the rest. Refreshes once at the end when anything applied.
   *
   * With `opts.intoChangelist === false` the restored files are immediately
   * un-opened again (`p4 revert -k`): content stays on disk but nothing lands
   * in a changelist. A failed revert leaves the file open (content is never
   * lost) and is reported in `keptOpen`.
   */
  async unshelveFiles(
    change: string,
    depotFiles: readonly string[],
    opts?: { intoChangelist?: boolean },
  ): Promise<{
    applied: string[]
    skipped: { depotFile: string; reason: string }[]
    keptOpen: { depotFile: string; reason: string }[]
  }> {
    const empty: {
      applied: string[]
      skipped: { depotFile: string; reason: string }[]
      keptOpen: { depotFile: string; reason: string }[]
    } = { applied: [], skipped: [], keptOpen: [] }
    if (!change || change === 'default' || depotFiles.length === 0) return empty
    return this._withBusy(this._busyLabel('unshelve'), async () => {
      const batch = await this._p4.exec(['unshelve', '-s', change, '-f', ...depotFiles])
      // A committed change has no shelf to unshelve (approved-and-committed
      // reviews) — force-apply by printing the committed snapshot instead.
      if (batch.exitCode !== 0 && /already committed/i.test(batch.stderr)) {
        this._log?.(
          `[perforce] unshelve -s ${change} refused (already committed) — applying via print`,
        )
        return this._applyCommittedChange(change, depotFiles, opts)
      }
      const result =
        batch.exitCode === 0
          ? { applied: [...depotFiles], skipped: empty.skipped }
          : await this._unshelveFilesIndividually(change, depotFiles)
      let keptOpen = empty.keptOpen
      if (result.applied.length > 0 && opts?.intoChangelist === false) {
        keptOpen = await this._unopenFilesKeepContent(result.applied)
      }
      if (result.applied.length > 0) {
        this._cache.invalidateWorkspace()
        await this.refresh()
      }
      return { ...result, keptOpen }
    })
  }

  /** Un-open files while keeping their workspace content (`p4 revert -k`).
   *  Used after an unshelve that must not land in a changelist. A failed
   *  revert is a safe degradation (file stays open, content intact) and comes
   *  back with the first non-empty stderr line as the reason. Unlike
   *  `moveToReconcile` this deliberately does NOT call `refreshReconcilePaths`
   *  — the point is that the files show up nowhere until the next reconcile
   *  scan. */
  private async _unopenFilesKeepContent(
    depotFiles: readonly string[],
  ): Promise<{ depotFile: string; reason: string }[]> {
    const batch = await this._p4.exec(['revert', '-k', ...depotFiles])
    if (batch.exitCode === 0) return []
    const keptOpen: { depotFile: string; reason: string }[] = []
    for (const depotFile of depotFiles) {
      const res = await this._p4.exec(['revert', '-k', depotFile])
      if (res.exitCode !== 0) {
        const reason = firstStderrLine(res.stderr) ?? `p4 revert -k failed (exit ${res.exitCode})`
        keptOpen.push({ depotFile, reason })
      }
    }
    return keptOpen
  }

  /** Force-apply a COMMITTED change's files: `p4 unshelve` only works on
   *  pending shelves, so approved-and-committed reviews take this path —
   *  print each file's content as of the change (`@=<change>`) and write it
   *  over the local copy. With `intoChangelist` the files are first opened
   *  for edit (default changelist, which also clears the read-only bit);
   *  otherwise they stay un-opened and a read-only local file is chmodded
   *  writable. Files that can't be mapped / edited / printed / written land
   *  in `skipped`; `keptOpen` is always empty here (a failed edit already
   *  skips the file). */
  private async _applyCommittedChange(
    change: string,
    depotFiles: readonly string[],
    opts?: { intoChangelist?: boolean },
  ): Promise<{
    applied: string[]
    skipped: { depotFile: string; reason: string }[]
    keptOpen: { depotFile: string; reason: string }[]
  }> {
    const applied: string[] = []
    const skipped: { depotFile: string; reason: string }[] = []
    const localByDepot = await this._whereLocalPaths(depotFiles)
    const editFailed = new Set<string>()
    if (opts?.intoChangelist !== false) {
      const mappable = depotFiles.filter((f) => localByDepot.has(f))
      const batchEdit = mappable.length > 0 ? await this._p4.exec(['edit', ...mappable]) : undefined
      if (batchEdit && batchEdit.exitCode !== 0) {
        for (const depotFile of mappable) {
          const res = await this._p4.exec(['edit', depotFile])
          // Already-open files are fine — overwriting them is the point.
          if (res.exitCode !== 0 && !/already opened/i.test(res.stderr)) {
            editFailed.add(depotFile)
            skipped.push({
              depotFile,
              reason: firstStderrLine(res.stderr) ?? `p4 edit failed (exit ${res.exitCode})`,
            })
          }
        }
      }
    }
    for (const depotFile of depotFiles) {
      if (editFailed.has(depotFile)) continue
      const local = localByDepot.get(depotFile)
      if (!local) {
        skipped.push({ depotFile, reason: 'not mapped in the client view' })
        continue
      }
      const res = await this._p4.execBinary(['print', '-q', `${depotFile}@=${change}`], {
        noClient: true,
      })
      if (res.exitCode !== 0) {
        skipped.push({
          depotFile,
          reason: firstStderrLine(res.stderr) ?? `p4 print failed (exit ${res.exitCode})`,
        })
        continue
      }
      try {
        await writeFile(local, res.stdout)
      } catch {
        // Un-opened p4 workspace files are read-only — make writable and retry.
        try {
          await chmod(local, 0o666)
          await writeFile(local, res.stdout)
        } catch (e: unknown) {
          skipped.push({ depotFile, reason: e instanceof Error ? e.message : String(e) })
          continue
        }
      }
      applied.push(depotFile)
    }
    if (applied.length > 0) {
      this._cache.invalidateWorkspace()
      await this.refresh()
    }
    return { applied, skipped, keptOpen: [] }
  }

  /** Per-file unshelve retry after a batch failure. A single-file unshelve is
   *  idempotent (`-f` overwrites), so files the batch already restored report
   *  success again; only genuinely refused files land in `skipped`, with the
   *  first non-empty stderr line as the reason. */
  private async _unshelveFilesIndividually(
    change: string,
    depotFiles: readonly string[],
  ): Promise<{ applied: string[]; skipped: { depotFile: string; reason: string }[] }> {
    const applied: string[] = []
    const skipped: { depotFile: string; reason: string }[] = []
    for (const depotFile of depotFiles) {
      const res = await this._p4.exec(['unshelve', '-s', change, '-f', depotFile])
      if (res.exitCode === 0) {
        applied.push(depotFile)
      } else {
        const reason = firstStderrLine(res.stderr) ?? `p4 unshelve failed (exit ${res.exitCode})`
        skipped.push({ depotFile, reason })
      }
    }
    return { applied, skipped }
  }

  /** Delete a changelist's shelved files from the server (`p4 shelve -d`). */
  async deleteShelved(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('delete shelved', ['shelve', '-d', '-c', changelist])
  }

  /** Delete a single shelved file from the server (`p4 shelve -d -c <id> <depotFile>`). */
  async deleteShelvedFile(changelist: string, depotFile: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('delete shelved', ['shelve', '-d', '-c', changelist, depotFile])
  }

  // --- Sync (get revision) -------------------------------------------------

  /**
   * Run `p4 sync` and report what actually landed.
   *
   * Deliberately not routed through {@link _mutate}: that returns a bare boolean,
   * and a sync's whole point is the summary — how many files updated, how many
   * were skipped because they're open, how many now need a resolve. The skeleton
   * is otherwise identical (busy label, user-cancellable, refresh either way,
   * cache invalidation on success).
   *
   * `spec` is the revision suffix p4 understands (`#head`, `#4`, `@12345`,
   * `@2026/08/01`), appended to each scope filespec. `force` is `p4 sync -f` —
   * it re-fetches files p4 thinks you already have, and overwrites writable
   * local files, so the caller must confirm first.
   */
  async sync(
    spec: string,
    options?: { scope?: readonly string[]; force?: boolean },
  ): Promise<SyncRunResult> {
    const targets = this._syncTargets(spec, options?.scope)
    const args = ['sync', ...(options?.force === true ? ['-f'] : []), ...targets]
    return this._withBusy(localize('perforce.busy.sync', 'Syncing'), async () => {
      const { value: result, cancelled } = await this._cancellable((signal) =>
        this._p4.exec(args, { signal }),
      )
      if (cancelled) {
        // The user asked for this — log it, don't toast it, and still refresh so
        // the view reflects whatever landed before the abort.
        this._log?.('[perforce] sync cancelled by user')
        await this._refreshAfterMutation()
        return {
          ok: false,
          cancelled: true,
          summary: undefined,
          refusedFiles: [],
          error: undefined,
        }
      }
      const summary = parseSyncOutput(result.stdout, result.stderr)
      const refusedFiles = parseSyncRefused(result.stdout, this.root)
      // Measured on P4D 2024.2: "file(s) up-to-date." arrives on **stderr with
      // exit 0**. Checked before the exit code so the outcome is the same however
      // a given server reports it — a future non-zero variant must not read as a
      // failure, and this one must not read as "applied 0 files, something's off".
      if (summary.upToDate && summary.applied === 0 && summary.refusedModified === 0) {
        this._log?.('[perforce] sync: already up to date')
        return { ok: true, cancelled: false, summary, refusedFiles, error: undefined }
      }
      if (result.exitCode !== 0) {
        const error = classifySyncError(result)
        this._log?.(`[perforce] sync failed (${error.kind}): ${p4ErrorText(result)}`)
        await this._refreshAfterMutation()
        return { ok: false, cancelled: false, summary, refusedFiles, error }
      }
      if (summary.unrecognized) {
        // Exit 0 with output we couldn't account for: never silent — the counts
        // shown to the user would otherwise read as "nothing happened".
        this._log?.(
          `[perforce] sync: output not parseable, reporting as unknown — ${result.stdout.trim().slice(0, 500)}`,
        )
      }
      this._log?.(
        `[perforce] sync ${spec}: ${summary.applied} applied, ${summary.keptOpen} kept open, ` +
          `${summary.mustResolve} need resolve, ${summary.refusedModified} refused (locally modified)`,
      )
      // A sync rewrites have-revisions across the scope, so every path-keyed
      // cache entry (fstat/print/filelog) is potentially stale — full clear.
      this._cache.invalidateWorkspace()
      await this._refreshAfterMutation()
      // The behind count is stale by definition now, and the user just acted on
      // it — `force` skips the interval floor so the status bar doesn't keep
      // showing the number they clicked to clear for another few minutes.
      this.scheduleSyncPreview({ force: true })
      return { ok: true, cancelled: false, summary, refusedFiles, error: undefined }
    })
  }

  /** Sync a specific set of local paths to `spec` (defaults to `#head`). Used by
   *  the Explorer's per-file/folder "get latest revision". */
  async syncFiles(
    paths: readonly string[],
    spec = '#head',
    options?: { force?: boolean },
  ): Promise<SyncRunResult> {
    if (paths.length === 0) {
      return { ok: false, cancelled: false, summary: undefined, refusedFiles: [], error: undefined }
    }
    return this.sync(spec, {
      scope: paths,
      ...(options?.force !== undefined ? { force: options.force } : {}),
    })
  }

  /**
   * Dry-run `p4 sync -n`: what *would* a sync bring in.
   *
   * Goes through `execTagged` (`-ztag`) rather than `execRecords`: measured on
   * P4D 2024.2, `-Mj sync -n` collapses to `{"data":...}` blobs in **both** the
   * has-updates and the up-to-date case, so `execRecords` would pay for a
   * guaranteed-useless `-Mj` spawn before falling back every single time.
   *
   * Runs at **background** priority — the scope-wide server comparison must never
   * take the slot a user's click is waiting on. `limit` becomes `-m <n>`, which
   * bounds how many records come back but — measured, and the whole reason
   * {@link runSyncPreviewScan} needs a cheap gate in front — **not** how much of the
   * client view the server walks. Pass `timeoutMs` for any caller that must not
   * hold a gate slot for the full command budget.
   */
  async previewSync(
    scope?: readonly string[],
    spec = '#head',
    limit?: number,
    options?: { timeoutMs?: number },
  ): Promise<{
    ok: boolean
    files: SyncPreviewFile[]
    total: number | undefined
    upToDate: boolean
  }> {
    const targets = this._syncTargets(spec, scope)
    const limitArgs = limit !== undefined && limit > 0 ? ['-m', String(limit)] : []
    const res = await this._p4.execTagged(
      ['sync', '-n', ...limitArgs, ...targets],
      options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
    )
    // `-ztag` drops the plain refusal lines an `allwrite noclobber` client emits
    // for locally-modified files, and those files ARE behind — folding them back
    // in is what stops a single-file preview (no structured records at all) from
    // reporting "up to date" while the revision chip shows `↓`.
    const refused = parseSyncRefused(res.result.stdout, this.root)
    // Measured: "up-to-date" arrives on **stderr with exit 0** and no records, so
    // it has to be tested before the exit code — not only in a failure branch.
    // Refusals outrank it: a multi-filespec run can report one scope up to date
    // while refusing files in another, and answering "up to date" there would
    // hide exactly the files the user needs to act on.
    if (refused.length === 0 && classifySyncError(res.result).kind === 'upToDate') {
      return { ok: true, files: [], total: undefined, upToDate: true }
    }
    if (res.result.exitCode !== 0) {
      this._log?.(`[perforce] sync -n failed: ${p4ErrorText(res.result)}`)
      return { ok: false, files: [], total: undefined, upToDate: false }
    }
    const files = [...parseSyncPreview(res.records, this.root), ...refused]
    // `total` stays record-derived on purpose: measured, `totalFileCount` already
    // counts the refusal lines, so adding them again would double-count on a wide
    // scope. Where the server omits it, the caller falls back to `files.length`,
    // which now includes them.
    const total = parseSyncPreviewTotal(res.records)
    return { ok: true, files, total, upToDate: files.length === 0 }
  }

  /** Append the revision `spec` to each target filespec, falling back to the
   *  configured sync scope when the caller gives none. Local paths are passed
   *  through verbatim (p4 accepts them); directories must already carry `/...`. */
  private _syncTargets(spec: string, scope?: readonly string[]): string[] {
    const base = scope !== undefined && scope.length > 0 ? scope : this._syncScopes
    return base.map((target) => `${target}${spec}`)
  }

  // --- Behind awareness ----------------------------------------------------

  /** Apply `perforce.syncPreview.*`. Turning auto-check off clears what's shown:
   *  stale ↓ markers are worse than none, since nothing will refresh them. */
  setSyncPreviewOptions(options: { autoCheck: boolean; intervalMs: number }): void {
    this._syncPreviewAutoCheck = options.autoCheck
    this._syncPreviewIntervalMs = Math.max(SYNC_PREVIEW_MIN_INTERVAL_MS, options.intervalMs)
    if (!options.autoCheck) {
      this._syncBehindCount = undefined
      this._syncBehindCapped = false
      // Same reason as going offline: a remembered marker would make the first
      // check after re-enabling skip itself and leave the count blank.
      this._lastDepotMarker = undefined
      if (this._behindDecorations.size > 0) {
        this._behindDecorations.clear()
        this._publishSupplementaryDecorations()
      }
      this._emitChange()
    }
  }

  /**
   * Compare the sync scope against the depot and report how far behind this client
   * is, publishing a grey ↓ marker per file.
   *
   * **Two tiers, because the obvious one-tier design is unusable.** Measured on a
   * 450k-file workspace, `sync -n` over the client root returns nothing in 120s —
   * `-m` bounds the reply, not the server's walk of the client view. So:
   *
   * 1. A cheap gate (`changes -m 1 -s submitted <scope>`, ~130ms even at client-root
   *    scope) asks only "has anything been submitted here since I last looked". In
   *    the steady state the answer is no and this method stops right here, having
   *    spent a tenth of a second.
   * 2. Only when that highest changelist actually moved does the expensive
   *    `sync -n` run, under {@link SYNC_PREVIEW_TIMEOUT_MS}.
   *
   * `force` skips tier 1 — a user who clicked "check now" gets the real comparison
   * even if the gate would have short-circuited it.
   *
   * The count comes from the server's `totalFileCount` when it reports one: that
   * is the untruncated total of files the sync would act on (measured: it
   * survives `-m` and counts the plain-line refusals too), so a scope with more
   * behind files than the decoration cap still gets its real count. Without the
   * field (older servers) the returned record count is the fallback — logged,
   * because that count is truncated whenever the reply saturated `-m`.
   *
   * `capped` says the count passed the decoration cap: per-file markers are
   * dropped then, and the count is a floor, not a total.
   */
  async runSyncPreviewScan(options?: {
    force?: boolean
  }): Promise<{ behind: number; capped: boolean; ok: boolean; skipped: boolean }> {
    const force = options?.force === true
    // Held, not committed: the marker may only advance once the expensive pass it
    // gates has actually produced a result. Advancing it up front means a single
    // timed-out `sync -n` short-circuits every later check until someone submits
    // again — the count would sit at a stale value for hours with no way back.
    let observedMarker: string | undefined
    if (!force) {
      const gate = await this._latestSubmittedChange()
      if (gate.ok && gate.marker !== undefined) {
        if (gate.marker === this._lastDepotMarker) {
          // Nothing was submitted in this scope since the last check, so nothing can
          // have made us newly behind. Skipping is the whole point of the gate.
          return {
            behind: this._syncBehindCount ?? 0,
            capped: this._syncBehindCapped,
            ok: true,
            skipped: true,
          }
        }
        observedMarker = gate.marker
      }
    }
    // `-m 501` bounds how many records come back — the cap decision must NOT
    // trust a saturated reply. `totalFileCount` (measured: one grand total in
    // the first record, untruncated under `-m`) is the real number; only when
    // the server doesn't report it do we fall back to the truncated record
    // count and say so.
    const probe = SYNC_PREVIEW_MAX_DECORATIONS + 1
    const res = await this.previewSync(undefined, '#head', probe, {
      timeoutMs: SYNC_PREVIEW_TIMEOUT_MS,
    })
    if (!res.ok) {
      // Degrade visibly in the log only: a failed or timed-out probe is not
      // evidence that the client is current, so the previous count and markers
      // stay exactly as they are — and the marker stays put too, so the next
      // check retries instead of trusting a gate reading it never acted on.
      this._log?.('[perforce] behind-check failed; keeping the previous result')
      return {
        behind: this._syncBehindCount ?? 0,
        capped: this._syncBehindCapped,
        ok: false,
        skipped: false,
      }
    }
    if (observedMarker !== undefined) this._lastDepotMarker = observedMarker
    let behind: number
    let capped: boolean
    if (res.total !== undefined) {
      capped = res.total > SYNC_PREVIEW_MAX_DECORATIONS
      behind = res.total
    } else {
      // A reply WITH records but no totalFileCount means the server doesn't
      // report the field (an empty reply is just "up to date") — say so,
      // because that record count is truncated whenever `-m` saturated it.
      if (res.files.length > 0) {
        this._log?.(
          '[perforce] behind-check: sync -n reported no totalFileCount; ' +
            'falling back to the returned record count',
        )
      }
      capped = res.files.length > SYNC_PREVIEW_MAX_DECORATIONS
      behind = capped ? SYNC_PREVIEW_MAX_DECORATIONS : res.files.length
    }
    this._syncBehindCount = behind
    this._syncBehindCapped = capped
    this._behindDecorations.clear()
    if (capped) {
      // Never silent: an Explorer with no markers plus a number in the status bar
      // would otherwise read as a contradiction the user can't explain.
      this._log?.(
        `[perforce] behind-check: more than ${SYNC_PREVIEW_MAX_DECORATIONS} files behind; ` +
          `showing the count only, no per-file markers`,
      )
    } else {
      for (const file of res.files) {
        const local = file.clientFile
        // No local path means the file isn't in this client's view — there is no
        // Explorer row to decorate, and the count already includes it.
        if (!local) continue
        this._behindDecorations.set(scopeKey(local), {
          resourceUri: local,
          description: localize('perforce.deco.behind', '↓'),
          tooltip: localize(
            'perforce.deco.behind.tooltip',
            'Update available — the server has a newer revision ({0} #{1}). Use Get Latest Revision to fetch it.',
            { 0: file.action, 1: file.rev },
          ),
        })
      }
    }
    this._publishSupplementaryDecorations()
    this._emitChange()
    this._log?.(`[perforce] behind-check: ${behind}${capped ? '+' : ''} file(s) behind`)
    return { behind, capped, ok: true, skipped: false }
  }

  /**
   * The cheap gate: the highest submitted changelist per sync-scope filespec,
   * joined into one comparable marker.
   *
   * `changes -m 1 -s submitted <scope>` is ~1000× cheaper than `sync -n` on the
   * same scope (130ms vs >120s at client-root scope) because it reads the change
   * table instead of walking the client view. `-m 1` applies **per filespec**, so a
   * multi-scope client yields one id each and the joined string changes if any of
   * them moves.
   *
   * Deliberately not `<scope>#have`, which would answer the sharper question "what
   * do I hold" — measured at 31s, 240× slower than the plain scope, because the
   * revision modifier forces exactly the per-file walk this gate exists to avoid.
   */
  private async _latestSubmittedChange(): Promise<{ ok: boolean; marker: string | undefined }> {
    const res = await this._p4.execTagged(
      ['changes', '-m', '1', '-s', 'submitted', ...this._syncScopes],
      { timeoutMs: SYNC_PREVIEW_GATE_TIMEOUT_MS },
    )
    if (res.result.exitCode !== 0) {
      // An unusable gate must fall through to the real check, never silently
      // report "nothing changed" — that would freeze the count forever.
      this._log?.(`[perforce] behind-check gate failed: ${p4ErrorText(res.result)}`)
      return { ok: false, marker: undefined }
    }
    const ids = parseChangesList(res.records).map((c) => c.id)
    // Zero records on a successful run is itself a stable answer — this scope has
    // never had a submitted change (an empty depot, or a focus folder that only
    // exists locally). It has to be a *comparable* marker rather than `undefined`,
    // or that workspace pays for the expensive pass on every single check while the
    // gate quietly never applies. A non-mapping filespec exits non-zero and is
    // already handled above, so this really does mean "nothing here yet".
    if (ids.length === 0) return { ok: true, marker: GATE_MARKER_NO_CHANGES }
    return { ok: true, marker: ids.join(',') }
  }

  /**
   * Run a behind-check in the background if one is due, and never block a caller.
   *
   * Four independent guards, because the expensive tier of a behind-check is the
   * most expensive read this extension issues: auto-check must be on, no check may
   * be in flight, the interval floor must have elapsed, and the client must be
   * connected. `force` (a user-initiated get just landed) skips the interval **and**
   * the cheap gate — a click deserves the real comparison, but still not two
   * overlapping scans.
   */
  scheduleSyncPreview(options?: { force?: boolean }): void {
    const force = options?.force === true
    if (!force && !this._syncPreviewAutoCheck) return
    if (this._backgroundSyncPreview) return
    if (this._connection !== 'connected') return
    const now = this._now()
    if (!force && now - this._lastSyncPreviewAt < this._syncPreviewIntervalMs) return
    this._lastSyncPreviewAt = now
    const run = (async () => {
      // Cross a macrotask first: chaining alone would still land inside the
      // caller's awaited window, so the spinner would cover a scan the user
      // never asked to wait for (same reasoning as _scheduleBackgroundReverify).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 0)
        timer.unref?.()
      })
      if (this._disposed) return
      await this.runSyncPreviewScan(force ? { force: true } : undefined)
    })()
      // Mandatory, not defensive: an unhandled rejection from a floating promise
      // takes down the whole extension host.
      .catch((err: unknown) => {
        this._log?.(`[perforce] background behind-check failed: ${String(err)}`)
      })
      .finally(() => {
        if (this._backgroundSyncPreview === run) this._backgroundSyncPreview = undefined
      })
    this._backgroundSyncPreview = run
  }

  /** Await any in-flight behind-check (tests; also lets callers settle). */
  async whenSyncPreviewSettled(): Promise<void> {
    await this._backgroundSyncPreview
  }

  // --- Opened-by-others awareness ------------------------------------------

  /** Apply `perforce.openedByOthers.*`. Turning auto-check off clears what's
   *  shown: stale ✎ markers are worse than none, since nothing will
   *  refresh them. */
  setOpenedByOthersOptions(options: { autoCheck: boolean; intervalMs: number }): void {
    this._openedByOthersAutoCheck = options.autoCheck
    this._openedByOthersIntervalMs = Math.max(OPENED_BY_OTHERS_MIN_INTERVAL_MS, options.intervalMs)
    if (!options.autoCheck) {
      this._openedByOthersCount = undefined
      this._openedByOthersCapped = false
      if (this._othersDecorations.size > 0) {
        this._othersDecorations.clear()
        this._publishSupplementaryDecorations()
      }
      this._emitChange()
    }
  }

  /**
   * Ask who has what open: `p4 opened -a` over the sync scope, filtered to other
   * clients, published as grey ✎ markers.
   *
   * No cheap gate in front (unlike the behind-check): `opened` reads the
   * server's *open table* rather than walking the client view, so its cost
   * scales with how many files are open anywhere, not with workspace size — a
   * 450k-file workspace doesn't make it slower, and there is no changes-table
   * signal that would tell us "someone opened something" anyway. What stays
   * unbounded is the reply on a busy shared server, so the probe always carries
   * `-m` (cap + 1) plus a tight timeout: a failed or timed-out probe keeps the
   * previous result, because it is not evidence that nobody has anything open.
   * The cap is judged on the RAW reply — `-a` includes this client's own
   * files, so judging on the filtered set would read a self-saturated probe
   * as "nobody has anything open" (a saturated reply keeps the previous
   * markers too, same as a failure).
   *
   * Local paths come from `p4 where` on the depot paths — NEVER from
   * translating the records' `clientFile`. Under `-a` that field is the *other*
   * client's client-syntax path (`//otherclient/...`), and translating it with
   * this client's root manufactures a local path that doesn't exist — the same
   * mistranslation as the old "edit renders as whole-file delete" bug.
   */
  async runOpenedByOthersScan(): Promise<{ others: number; capped: boolean; ok: boolean }> {
    const probe = OPENED_BY_OTHERS_MAX_DECORATIONS + 1
    const res = await this._p4.execRecords(
      ['opened', '-a', '-m', String(probe), ...this._syncScopes],
      { timeoutMs: OPENED_BY_OTHERS_TIMEOUT_MS },
    )
    if (res.result.exitCode !== 0) {
      // Degrade visibly in the log only: a failed or timed-out probe is not
      // evidence that nobody has anything open, so the previous count and
      // markers stay exactly as they are.
      this._log?.(`[perforce] opened-by-others scan failed: ${p4ErrorText(res.result)}`)
      return this._previousOpenedByOthersResult()
    }
    // Deliberately parsed WITHOUT this.root: under `-a`, `clientFile` is the
    // other client's client-syntax path, and the clientRoot translation would
    // fake a local path that doesn't exist.
    const others = filterOpenedByOthers(parseOpened(res.records), this._clientName)
    // The cap must be judged on the RAW reply, not on `others`: `opened -a`
    // includes this client's own files, so a user with >300 of their own open
    // can saturate the probe with records that all filter out — reading that
    // as "nobody has anything open" is exactly the silent-zero trap. A reply
    // at the probe size is "the open table is bigger than the cap", no matter
    // whose files happened to come first. (Measured: `opened -a` has no
    // `totalFileCount`, so the raw record count is all there is to judge by.)
    const capped = res.records.length >= probe
    const count = capped ? OPENED_BY_OTHERS_MAX_DECORATIONS : others.length
    if (capped) {
      // Never silent, and never clearing: truncation is NOT evidence that
      // nobody has anything open, so the previous markers stay put (same
      // semantics as a failed scan) and the log says why.
      this._openedByOthersCount = count
      this._openedByOthersCapped = true
      this._log?.(
        `[perforce] opened-by-others: the -m ${probe} probe saturated; ` +
          `showing the count only, keeping the previous markers`,
      )
      this._log?.(`[perforce] opened-by-others: ${count}+ file(s)`)
      this._emitChange()
      return { others: count, capped: true, ok: true }
    }
    let localByDepot: Map<string, string> | undefined
    if (others.length > 0) {
      const where = await this._whereLocalPathsResult(others.map((f) => f.depotFile))
      if (!where.ok) {
        // The lookup itself failed, so we don't know which files to mark: keep the
        // previous result rather than publish a fresh count next to markers that
        // no longer agree with it. Note this is NOT the same as an empty result —
        // on a real shared server most files opened by others live on branches
        // outside this client's view, so zero local paths is the normal case, and
        // treating it as a failure would keep the count blank forever.
        this._log?.('[perforce] opened-by-others where lookup failed; keeping the previous result')
        return this._previousOpenedByOthersResult()
      }
      localByDepot = where.paths
    }
    this._openedByOthersCount = count
    this._openedByOthersCapped = false
    this._othersDecorations.clear()
    if (localByDepot) {
      for (const file of others) {
        const local = localByDepot.get(file.depotFile)
        // No local path means the file isn't in this client's view — there is no
        // Explorer row to decorate (the count already includes it).
        if (!local) continue
        const client = file.openedByClient ?? ''
        const owner = file.openedByUser ? `${file.openedByUser}@${client}` : client
        this._othersDecorations.set(scopeKey(local), {
          resourceUri: local,
          description: localize('perforce.deco.occupied', '✎'),
          tooltip: localize(
            'perforce.deco.occupied.tooltip',
            'In use by others — {0} has this file open',
            {
              0: owner,
            },
          ),
        })
      }
    }
    this._publishSupplementaryDecorations()
    this._emitChange()
    this._log?.(`[perforce] opened-by-others: ${count} file(s)`)
    return { others: count, capped: false, ok: true }
  }

  /** The previous scan's result — what both failure paths report, since a
   *  failed probe changes nothing. */
  private _previousOpenedByOthersResult(): { others: number; capped: boolean; ok: boolean } {
    return { others: this._openedByOthersCount ?? 0, capped: this._openedByOthersCapped, ok: false }
  }

  /**
   * Run an opened-by-others scan in the background if one is due, and never
   * block a caller.
   *
   * The same four guards as the behind-check — auto-check on, no scan in flight,
   * the interval floor elapsed, client connected — kept as independent state
   * because the two scans have different costs and change at different rates.
   */
  scheduleOpenedByOthers(): void {
    if (!this._openedByOthersAutoCheck) return
    if (this._backgroundOpenedByOthers) return
    if (this._connection !== 'connected') return
    const now = this._now()
    if (now - this._lastOpenedByOthersAt < this._openedByOthersIntervalMs) return
    this._lastOpenedByOthersAt = now
    const run = (async () => {
      // Cross a macrotask first: chaining alone would still land inside the
      // caller's awaited window, so the spinner would cover a scan the user
      // never asked to wait for (same reasoning as _scheduleBackgroundReverify).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 0)
        timer.unref?.()
      })
      if (this._disposed) return
      await this.runOpenedByOthersScan()
    })()
      // Mandatory, not defensive: an unhandled rejection from a floating promise
      // takes down the whole extension host.
      .catch((err: unknown) => {
        this._log?.(`[perforce] background opened-by-others scan failed: ${String(err)}`)
      })
      .finally(() => {
        if (this._backgroundOpenedByOthers === run) this._backgroundOpenedByOthers = undefined
      })
    this._backgroundOpenedByOthers = run
  }

  /** Await any in-flight opened-by-others scan (tests; also lets callers settle). */
  async whenOpenedByOthersSettled(): Promise<void> {
    await this._backgroundOpenedByOthers
  }

  /**
   * Publish the union of every supplementary-decoration producer.
   *
   * The channel replaces the provider's whole set, so each producer keeps its own
   * map and this is the single place they merge — a producer that published its
   * slice directly would silently erase the others'. A file can appear in two
   * maps at once (behind *and* open by someone else); it publishes as ONE entry
   * then, because the renderer keys decorations by path and a second entry would
   * silently overwrite the first.
   */
  private _publishSupplementaryDecorations(): void {
    const merged = new Map<string, SourceControlSupplementaryDecoration>(this._behindDecorations)
    for (const [key, deco] of this._othersDecorations) {
      const behind = merged.get(key)
      if (!behind) {
        merged.set(key, deco)
        continue
      }
      // Both facts matter and the grey line only fits two glyphs — join the
      // descriptions; the tooltip keeps each producer's full detail. Tooltip
      // order follows the glyph order (✎ then ↓) so the hover reads in the same
      // sequence the row does.
      const tooltip = [deco.tooltip, behind.tooltip]
        .filter((t): t is string => t !== undefined)
        .join('\n')
      merged.set(key, {
        resourceUri: deco.resourceUri,
        description: localize('perforce.deco.occupiedAndBehind', '✎ ↓'),
        ...(tooltip.length > 0 ? { tooltip } : {}),
      })
    }
    this._sc.setSupplementaryDecorations([...merged.values()])
  }

  // --- Resolve (Phase 3) ---------------------------------------------------

  /**
   * Auto-resolve files with the safe merge strategy (`p4 resolve -am`): accepts
   * clean automatic merges, leaves genuine conflicts open for manual handling.
   *
   * Deliberately NOT routed through {@link _mutate}: `-am` exits 0 even when some
   * files are left unresolved, so exit-code-only handling would silently swallow
   * the "partially resolved" outcome — the user clicks Resolve and gets nothing.
   * The skeleton mirrors `_mutate` (busy label, user-cancellable, cache
   * invalidation, refresh either way), but the outcome is reported from TWO
   * sources: the merge transcript text is a first signal, and the freshly
   * refreshed `opened` is authoritative — how many of the resolved paths the
   * server STILL reports unresolved after the run is what "remaining" means.
   * The text counts are the fallback when the post-resolve refresh lost the
   * connection (nothing authoritative exists then).
   */
  async resolve(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    return this._runResolve(['resolve', '-am', ...paths], paths)
  }

  /**
   * Shared core for every `-am` entry point. Both the per-row and the whole-group
   * command must report the partial outcome; the group one is the *more* common
   * click, so leaving it on the exit-code-only path would have kept the silent
   * failure exactly where users meet it most.
   *
   * `candidates` are the rows this run was expected to resolve — the denominator
   * for "auto-merged N" and the set re-checked against the refreshed `opened`.
   */
  private async _runResolve(
    args: readonly string[],
    candidates: readonly string[],
  ): Promise<boolean> {
    return this._withBusy(this._busyLabel('resolve'), async () => {
      const { value: result, cancelled } = await this._cancellable((signal) =>
        this._p4.exec([...args], { signal }),
      )
      if (cancelled) {
        // The user asked for this — log it, don't toast it, and still refresh so
        // the view reflects whatever landed before the abort.
        this._log?.('[perforce] resolve cancelled by user')
        await this._refreshAfterMutation()
        return false
      }
      if (result.exitCode !== 0) {
        await notifyP4Failure('resolve', result)
        await this._refreshAfterMutation()
        return false
      }
      const text = parseResolveOutput(result.stdout)
      if (text.unrecognized) {
        // Never silent: exit 0 with output we couldn't account for means the
        // counts below would otherwise read as "nothing happened".
        this._log?.(
          `[perforce] resolve: output not parseable, reporting as unknown — ${result.stdout.trim().slice(0, 500)}`,
        )
      }
      this._invalidateAfterMutation(candidates)
      await this._refreshAfterMutation()
      // The refresh is authoritative when the connection survived; the merge
      // transcript is the fallback when it didn't (the refresh's `opened` may
      // have gone offline, clearing _unresolvedPaths).
      const authoritative = this._connection === 'connected'
      const remaining = authoritative
        ? candidates.filter((p) => this._unresolvedPaths.has(norm(p))).length
        : text.remaining
      const merged = authoritative ? candidates.length - remaining : text.merged
      if ((text.unrecognized && remaining === 0) || (merged === 0 && remaining === 0)) {
        // Exit 0 but no source accounts for any effect: the transcript
        // recognized nothing (logged above) and the server reports nothing
        // left to resolve (e.g. "no file(s) to resolve" on an already-resolved
        // row). Never silent, and never fabricate an "auto-merged N".
        await window.showInformationMessage(
          localize('perforce.resolve.completed', 'Resolve completed.'),
        )
        return true
      }
      const message =
        merged > 0 && remaining > 0
          ? localize(
              'perforce.resolve.summary',
              'Auto-merged {0}; {1} still need manual resolution.',
              {
                0: String(merged),
                1: String(remaining),
              },
            )
          : merged > 0
            ? localize('perforce.resolve.done', 'Auto-merged {0} file(s).', {
                0: String(merged),
              })
            : localize('perforce.resolve.still', '{0} file(s) still need manual resolution.', {
                0: String(remaining),
              })
      if (remaining > 0) {
        // Guide the user to what's left: open the 3-way merge editor on the
        // first file that is still unresolved.
        const BTN_RESOLVE = localize('perforce.btn.resolveNow', 'Resolve Conflicts')
        const picked = await window.showWarningMessage(message, BTN_RESOLVE)
        if (picked === BTN_RESOLVE) {
          const first = candidates.find((p) => this._unresolvedPaths.has(norm(p)))
          if (first) await commands.executeCommand('perforce.openMergeEditor', first)
        }
        return true
      }
      await window.showInformationMessage(message)
      return true
    })
  }

  /** Accept our side of each merge (`p4 resolve -ay`) — discards the incoming
   *  side, so the command layer confirms first. */
  async resolveAcceptYours(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    return this._mutate('resolve', ['resolve', '-ay'], paths)
  }

  /** Accept the incoming side of each merge (`p4 resolve -at`) — discards our
   *  local edits, so the command layer confirms first. */
  async resolveAcceptTheirs(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    return this._mutate('resolve', ['resolve', '-at'], paths)
  }

  /**
   * Accept the just-saved merge-editor result as "ours" (`p4 resolve -ay`):
   * the user hand-merged on disk, so saving means "take my content". Backs the
   * runtime command `perforce.acceptResolved` (the merge editor's saveCommand).
   * No confirmation — saving the merge editor IS the confirmation.
   */
  async acceptResolved(localPath: string): Promise<boolean> {
    return this._mutate('resolve', ['resolve', '-ay'], [localPath])
  }

  /**
   * Open the 3-way merge editor for an unresolved file. base = the have revision
   * content (`depotFile#haveRev`), incoming = the depot head (`depotFile#headRev`),
   * current + merged = the on-disk file — its p4 conflict markers are recognized
   * by the renderer's conflictParser, so the result pane seeds with the raw
   * conflicted content. Saving the merged result runs `perforce.acceptResolved`
   * (see MergeEditorInput.saveCommand).
   *
   * fstat is a metadata read, so it keeps the interactive tight timeout; the two
   * prints are whole-file content transfers and keep the generous command budget
   * (INTERACTIVE_CONTENT_EXEC — a 30s cap would kill a large file on a slow link).
   */
  async openMergeEditor(localPath: string): Promise<void> {
    await this._withBusy(
      localize('perforce.busy.openMergeEditor', 'Opening Merge Editor'),
      async () => {
        const title = localize('perforce.command.openMergeEditor.title', 'Open Merge Editor')
        const res = await this._p4.execRecords(['fstat', localPath], INTERACTIVE_EXEC)
        if (res.result.exitCode !== 0) {
          await notifyP4Failure(title, res.result)
          return
        }
        const info = parseFstat(res.records)[0]
        if (!info) {
          // Not under depot control — there is nothing to three-way merge against.
          await window.showErrorMessage(
            localize(
              'perforce.openMergeEditor.notControlled',
              'The file is not under depot control.',
            ),
          )
          return
        }
        // `haveRev` is 'none' for an open-for-add file (no have revision yet) —
        // the base side is simply empty then, like git's added-on-both-sides merge.
        const haveRev = info.haveRev && info.haveRev !== 'none' ? info.haveRev : undefined
        const baseSpec = haveRev ? `${info.depotFile}#${haveRev}` : null
        const incomingSpec = info.headRev ? `${info.depotFile}#${info.headRev}` : null
        const [base, incoming] = await Promise.all([
          this.printRevision(baseSpec),
          this.printRevision(incomingSpec),
        ])
        let current = ''
        try {
          current = await readFile(localPath, 'utf8')
        } catch {
          current = '' // deleted on disk
        }
        const currentLabel = haveRev
          ? localize('perforce.mergeEditor.yoursRev', 'Yours (have #{0})', { 0: haveRev })
          : localize('perforce.mergeEditor.yours', 'Yours')
        const incomingLabel = info.headRev
          ? localize('perforce.mergeEditor.theirsRev', 'Theirs (head #{0})', {
              0: info.headRev,
            })
          : localize('perforce.mergeEditor.theirs', 'Theirs')
        await commands.executeCommand('_workbench.openMergeEditor', {
          path: localPath,
          base,
          current,
          incoming,
          merged: current,
          currentLabel,
          incomingLabel,
          saveCommand: {
            command: 'perforce.acceptResolved',
            arguments: [localPath],
          },
        })
      },
    )
  }

  /** Auto-resolve every unresolved file in a numbered changelist. */
  async resolveChangelist(changelist: string): Promise<boolean> {
    // The candidate set has to be captured BEFORE the run: afterwards the
    // resolved rows are gone from `_changelistByPath`, and an empty denominator
    // would report every partial merge as "nothing happened".
    const candidates = this.pathsInChangelist(changelist).filter((p) =>
      this._unresolvedPaths.has(norm(p)),
    )
    const args =
      changelist === 'default' ? ['resolve', '-am'] : ['resolve', '-am', '-c', changelist]
    return this._runResolve(args, candidates)
  }

  /**
   * Open a diff of a shelved file: left = the file's base revision content from
   * the depot (`depotFile#rev`), right = the shelved content (`depotFile@=<cl>`).
   * An added file has no base revision, so it just opens the shelved content on
   * the right (empty left). Shelved files have no local working copy, so both
   * sides come from `p4 print`.
   */
  async openShelvedFile(
    changelist: string,
    depotFile: string,
    rev: string | undefined,
    action: P4Action,
  ): Promise<void> {
    const isAdd = action === 'add' || action === 'branch' || action === 'import'
    const baseSpec = !isAdd && rev ? `${depotFile}#${rev}` : null
    const shelfSpec = `${depotFile}@=${changelist}`
    const [original, modified] = await Promise.all([
      this.printRevision(baseSpec),
      this.printRevision(shelfSpec),
    ])
    const name = basename(displayPath(depotFile))
    await commands.executeCommand('_workbench.openDiff', {
      title: `${name} (Shelved #${changelist})`,
      originalUri: pathToFileURL(displayPath(depotFile)).href,
      original,
      modified,
      pinned: false,
      preserveFocus: false,
    })
  }

  /**
   * Delete a pending numbered changelist (`p4 change -d <n>`). Perforce refuses to
   * delete a changelist that still has open files, so the caller guards on that
   * first (matching P4V). Shelved files DO block `change -d`, so any shelf is
   * removed first (`shelve -d`) — mirroring P4V, where a shelf doesn't stop you
   * deleting the changelist. The default changelist can't be deleted.
   */
  async deleteChangelist(changelist: string): Promise<boolean> {
    if (changelist === 'default' || !/^\d+$/.test(changelist)) return false
    // Drop any shelved files first so `change -d` isn't blocked by them.
    const describe = await this._p4.execRecords(['describe', '-S', '-s', changelist])
    if (describe.result.exitCode === 0 && parseShelved(describe.records).length > 0) {
      const del = await this._p4.exec(['shelve', '-d', '-c', changelist])
      if (del.exitCode !== 0) {
        await notifyP4Failure('delete changelist', del)
        await this.refresh()
        return false
      }
    }
    return this._mutate('delete changelist', ['change', '-d', changelist])
  }

  /** Whether a changelist currently has any open files (blocks deletion). Reads
   *  the last refresh's opened→changelist map, so no extra round-trip. */
  hasOpenFiles(changelist: string): boolean {
    for (const cl of this._changelistByPath.values()) {
      if (cl === changelist) return true
    }
    return false
  }

  /**
   * Move files out of their changelist without touching the working tree
   * (`p4 revert -k`): the open state is discarded but local content is kept, so
   * the files reappear in the "changes to reconcile" group (their disk state has
   * diverged from the depot but they're no longer opened).
   *
   * Only the moved paths are re-scanned (`refreshReconcilePaths`, O(paths)) — the
   * paths are known, so there's no need for a full `reconcile -n` walk of the
   * whole workspace (which was slow on large depots). Any prior dismissal of a
   * moved path is cleared, since moving it out is an explicit request to see it.
   */
  async moveToReconcile(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    this._reconcileActive = true
    this._undismiss(paths)
    const ok = await this._mutate('revert -k', ['revert', '-k'], paths)
    if (ok) {
      // `revert -k` dropped these from `opened`, but `_openedPaths` is only rebuilt
      // by a full refresh. Clear the moved paths locally first so the incremental
      // `refreshReconcilePaths` below doesn't filter them back out as still-opened.
      this._forgetOpenedPaths(paths)
      await this.refreshReconcilePaths(paths)
    }
    return ok
  }

  /** Drop paths from the opened-tracking maps without a full refresh, so an
   *  incremental reconcile rescan sees them as no longer opened. */
  private _forgetOpenedPaths(paths: readonly string[]): void {
    if (paths.length === 0) return
    const keys = new Set(paths.map(norm))
    this._openedPaths = new Set([...this._openedPaths].filter((p) => !keys.has(p)))
    this._changelistByPath = new Map([...this._changelistByPath].filter(([p]) => !keys.has(p)))
  }

  /**
   * Discard working-tree changes for not-yet-opened (reconcile) files
   * (`p4 clean -a -e -d`): re-adds files deleted on disk, deletes files added on
   * disk, and reverts edited-on-disk content back to the have revision. Destructive
   * (local edits are lost) — the command layer confirms first.
   *
   * Only the affected paths are re-scanned afterwards (they come back clean and
   * drop out of the group) — no full-tree walk. A directory target (`<dir>/...`)
   * is expanded to the concrete listed files under it for the rescan.
   */
  async revertReconcile(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    this._reconcileActive = true
    const affected = this._concreteReconcilePaths(paths)
    const ok = await this._mutate('clean', ['clean', '-a', '-e', '-d'], paths)
    if (ok && affected.length > 0) await this.refreshReconcilePaths(affected)
    return ok
  }

  /**
   * Permanently dismiss ("move out of") reconcile entries: add their normalized
   * local paths to the dismissed set so they never reappear in the group (even
   * after a Clean Refresh) until collected or cleared. Targets may be concrete
   * files, folder rows, or the whole group — directories are expanded to the
   * currently-listed files under them ({@link expandDismissPaths}). Persists and
   * re-renders without any p4 round-trip.
   */
  dismissReconcile(paths: readonly string[]): void {
    const keys = expandDismissPaths(
      paths.map((p) => p.replace(/[/\\]\.\.\.$/, '')),
      this._reconcileFiles,
    )
    if (keys.length === 0) return
    for (const k of keys) this._dismissed.add(k)
    // Re-render from the current list; _setReconcileFiles filters + persists.
    this._setReconcileFiles(this._reconcileFiles)
    this._emitChange()
  }

  /** Clear all dismissals (the "unignore everything" escape hatch) and run a full
   *  reconcile scan so any still-diverged files that were dismissed reappear. */
  async clearDismissed(): Promise<void> {
    if (this._dismissed.size === 0) return
    this._dismissed.clear()
    this._persistReconcile()
    await this.refresh({ reconcile: true })
  }

  /** Remove the given paths from the dismissed set (they're being re-included,
   *  e.g. explicitly collected or moved out again). Persists if anything changed. */
  private _undismiss(paths: readonly string[]): void {
    let changed = false
    for (const p of paths) if (this._dismissed.delete(norm(p))) changed = true
    if (changed) this._persistReconcile()
  }

  /** Expand reconcile targets (concrete files or `<dir>/...` / directory paths)
   *  into the concrete listed reconcile-file paths they cover, for an incremental
   *  rescan. Strips the p4 `/...` recursion suffix before prefix-matching. */
  private _concreteReconcilePaths(targets: readonly string[]): string[] {
    return expandDismissPaths(
      targets.map((p) => p.replace(/[/\\]\.\.\.$/, '')),
      this._reconcileFiles,
    )
  }

  /**
   * Open a diff of `localPath`: left = the have-revision content from the depot,
   * right = the local file content. Falls back to just opening the file when
   * there's no have revision (e.g. open-for-add). A *failed* fstat/print toasts
   * instead of silently opening the plain file, so the user knows the diff didn't
   * come up rather than mistaking "diff became a plain editor" for normal.
   */
  async openChange(localPath: string, pinned = false, preserveFocus = false): Promise<void> {
    await this._withBusy(localize('perforce.busy.openChange', 'Opening Changes'), async () => {
      if (isSpreadsheetPath(localPath)) {
        await this._openSpreadsheetChange(localPath, pinned, preserveFocus)
        return
      }
      const started = Date.now()
      const baseline = await this._baseline.getHaveContentResult(localPath)
      if (baseline.error) {
        await notifyP4Failure(
          localize('perforce.command.openChange.title', 'Open Changes'),
          baseline.error,
        )
        this._log?.(`[perforce] openChange failed after ${Date.now() - started}ms`)
        return
      }
      if (baseline.content === undefined) {
        // No have revision (open-for-add / not under depot control) — opening the
        // file is the correct fallback, there's no depot side to diff against.
        await commands.executeCommand('_workbench.openFile', localPath)
        return
      }
      const readStart = Date.now()
      let modified = ''
      try {
        modified = await readFile(localPath, 'utf8')
      } catch {
        modified = '' // deleted on disk
      }
      const readMs = Date.now() - readStart
      this._log?.(
        `[perforce] openChange fstat ${baseline.timings.fstatMs}ms / print ${baseline.timings.printMs}ms` +
          `${baseline.timings.printCached ? '(cached)' : ''} / read ${readMs}ms / total ${Date.now() - started}ms`,
      )
      await commands.executeCommand('_workbench.openDiff', {
        title: `${basename(localPath)} (Perforce)`,
        originalUri: pathToFileURL(localPath).href,
        original: baseline.content,
        modified,
        pinned,
        preserveFocus,
        openableUri: pathToFileURL(localPath).href,
        liveModified: true,
      })
    })
  }

  /**
   * Open a spreadsheet's have revision vs local content as a webview diff (the
   * Excel extension renders it). Baseline + local are read as raw bytes so the
   * xlsx isn't corrupted by UTF-8 decoding, then passed by value (base64).
   */
  private async _openSpreadsheetChange(
    localPath: string,
    pinned = false,
    preserveFocus = false,
  ): Promise<void> {
    const started = Date.now()
    const baseline = await this._baseline.getHaveContentBytesResult(localPath)
    if (baseline.error) {
      await notifyP4Failure(
        localize('perforce.command.openChange.title', 'Open Changes'),
        baseline.error,
      )
      this._log?.(`[perforce] openChange(spreadsheet) failed after ${Date.now() - started}ms`)
      return
    }
    if (baseline.content === undefined) {
      // No have revision — open the file directly (see openChange).
      await commands.executeCommand('_workbench.openFile', localPath)
      return
    }
    let modified: Buffer
    try {
      modified = await readFile(localPath)
    } catch {
      modified = Buffer.alloc(0) // deleted on disk
    }
    this._log?.(`[perforce] openChange(spreadsheet) total ${Date.now() - started}ms`)
    await commands.executeCommand('_workbench.openWebviewDiff', {
      viewType: 'universe.excel',
      title: `${basename(localPath)} (Perforce)`,
      leftUri: pathToFileURL(localPath).href,
      rightUri: pathToFileURL(localPath).href,
      leftBase64: baseline.content.toString('base64'),
      rightBase64: modified.toString('base64'),
      pinned,
      preserveFocus,
    })
  }

  /**
   * The have-revision content of `localPath` for the dirty-diff gutter baseline,
   * or null when the file has no have revision (open-for-add / outside the depot).
   * Contributed to the host as `perforce.getHeadContent`.
   */
  async getHeadContent(localPath: string): Promise<string | null> {
    const content = await this._baseline.getHaveContent(localPath)
    return content ?? null
  }

  /**
   * Blame for `localPath` in the {@link P4BlameResult} shape (== BlameResultDto),
   * or null when annotate fails (unsubmitted / non-depot file). Runs
   * `p4 annotate -c -q`, then resolves author/summary/time for the referenced
   * changelists from one `p4 changes -l <file>` (the file's own history).
   * Contributed to the host as `perforce.getBlame`.
   *
   * `-ztag`, not `-Mj`: on some servers (observed on P4D 2024.2) the JSON output
   * of `annotate` collapses every line into a single `data` blob and drops the
   * structured `lower`/`upper` fields — only tagged output carries them.
   *
   * Metadata deliberately does NOT come from `p4 describe -s <cl>`: a describe
   * lists every file in the changelist, and on a giant branch changelist
   * (hundreds of thousands of files) that output is gigabytes and the command
   * never returns (observed >3min on a real server) — blame stayed blank.
   * `changes -l <file>` is bounded by the file's own history and sub-second.
   */
  async getBlame(localPath: string): Promise<P4BlameResult | null> {
    const annotate = await this._p4.execTagged(
      ['annotate', '-c', '-q', localPath],
      INTERACTIVE_EXEC,
    )
    if (annotate.result.exitCode !== 0) return null
    const lines = parseAnnotate(annotate.records)
    if (lines.length === 0) return null

    const summaries = new Map<string, { summary: string; user?: string; time?: number }>()
    const json = await this._cache.wrap(
      P4CacheNs.changesSubmitted,
      `blame:${localPath}`,
      async () => {
        const changes = await this._p4.execTagged(['changes', '-l', localPath], INTERACTIVE_EXEC)
        if (changes.result.exitCode !== 0) return undefined
        return JSON.stringify(parseChangesList(changes.records))
      },
    )
    if (json) {
      for (const meta of JSON.parse(json) as GraphChangeMeta[]) {
        summaries.set(meta.id, {
          summary: meta.message,
          ...(meta.author ? { user: meta.author } : {}),
          ...(meta.date ? { time: meta.date * 1000 } : {}),
        })
      }
    }

    return buildBlameResult(lines, summaries)
  }

  /**
   * The subset of `paths` the client's ignore rules exclude, returned in the
   * exact input string form (the host keys the dimmed Explorer rows / editor
   * tabs against the input strings). Contributed to the host as
   * `perforce.checkIgnore`. Degrades to "nothing ignored" (empty array) on any
   * failure — the caller must never filter a row out on a broken answer.
   *
   * Runs `p4 ignores -i <paths…>` (a pure rule evaluator — p4 documents it as
   * a debugging aid for add/reconcile), then filters the survivors through
   * `p4 fstat` to drop files already under depot control (see the filter's
   * comment).
   */
  async checkIgnore(paths: readonly string[]): Promise<string[]> {
    // Connection guard first: this is a passive batch read the host fires while
    // scrolling the Explorer / switching editor tabs, so an offline client must
    // answer "nothing is ignored" without spawning a command that is doomed to
    // fail (which would flood the output channel on every scroll).
    if (this._connection !== 'connected') return []
    // No `-i` args sends `p4 ignores` into listing mode — a completely different
    // output — so the empty request never reaches the command.
    if (paths.length === 0) return []

    const candidates: string[] = []
    for (const batch of chunkByLength(paths)) {
      // Background priority (omitted), never interactive: this is a scroll-driven
      // batch decoration read, not a click waiting for a result. Marking it
      // interactive would consume the ConcurrencyGate's statically reserved slot
      // and queue real clicks (open diff) behind a scroll fan-out — the exact
      // "shared FIFO gate flooded → clicks queue for minutes" pathology this
      // extension already fixed once.
      let res: P4ExecResult
      try {
        res = await this._p4.exec(['ignores', '-i', ...batch], {
          timeoutMs: CHECK_IGNORE_TIMEOUT_MS,
        })
      } catch {
        // spawn failure (p4 missing) — degrade to "nothing ignored".
        return candidates
      }
      if (this._disposed) return candidates
      if (res.exitCode !== 0) {
        const kind = classifyP4Error(res)
        if (kind === 'offline' || kind === 'session-expired' || kind === 'not-logged-in') {
          this._goOffline(kind)
          // Abort the remaining batches: the connection is gone, they'd all fail
          // the same way.
          return candidates
        }
        // An unrelated per-batch failure must not sink the other batches, and
        // must never toast — this is not a user action.
        this._log?.(`[perforce] ignores failed (exit ${res.exitCode}): ${p4ErrorText(res)}`)
        continue
      }
      candidates.push(...parseIgnores(res.stdout, batch))
    }
    if (candidates.length === 0) return []

    // Depot filter: `p4 ignores -i` is a pure rule evaluator, so it may report a
    // file that is already in the depot (git's `check-ignore` consults the index
    // and never does). The renderer only dims rows that have no SCM decoration,
    // which a synced, unmodified controlled file also has — so without this pass
    // whole regions of the depot would dim. Drop every candidate that fstat shows
    // as in-depot with a non-delete head action; anything fstat doesn't answer for
    // keeps the candidate, because the ignore rule already matched and this pass
    // only refines it.
    const inDepot = new Set<string>()
    for (const batch of chunkByLength(candidates)) {
      let res: { result: P4ExecResult; records: Record<string, unknown>[] }
      try {
        res = await this._p4.execRecords(['fstat', '-T', 'clientFile,headAction', ...batch], {
          timeoutMs: CHECK_IGNORE_TIMEOUT_MS,
        })
      } catch (err) {
        this._log?.(`[perforce] fstat filter failed: ${String(err)}`)
        return candidates
      }
      if (this._disposed) return candidates
      if (res.result.exitCode !== 0) {
        const kind = classifyP4Error(res.result)
        if (kind === 'offline' || kind === 'session-expired' || kind === 'not-logged-in') {
          // The connection died between the two passes. Report nothing rather
          // than the unfiltered candidates: an unfiltered list dims controlled
          // files and the renderer caches that until the next invalidation.
          this._goOffline(kind)
          return []
        }
        // 🔴 A non-zero exit here is the NORMAL case, not a failure: this batch is
        // mostly local-only files and `p4 fstat` exits non-zero as soon as one
        // argument matches nothing (`no such file(s).`). The records for the files
        // it DID know are still on stdout, so keep filtering with them — an early
        // return would make the whole depot filter dead on a real server.
        this._log?.(
          `[perforce] fstat filter partial (exit ${res.result.exitCode}): ${p4ErrorText(res.result)}`,
        )
      }
      for (const r of res.records) {
        const clientFile = typeof r['clientFile'] === 'string' ? r['clientFile'] : undefined
        const headAction = typeof r['headAction'] === 'string' ? r['headAction'] : undefined
        // `clientFile` from fstat is a LOCAL path (the one command where it isn't
        // client syntax) — directly comparable to the candidates via scopeKey.
        if (clientFile && headAction && !headAction.includes('delete')) {
          inDepot.add(scopeKey(clientFile))
        }
      }
    }
    return candidates.filter((p) => !inDepot.has(scopeKey(p)))
  }

  // --- Perforce Graph (read-only history view) -----------------------------

  /** The client name, for the graph's repo picker / head label. */
  get clientName(): string {
    return this._clientName
  }

  /** The bound p4 service, so the Swarm submodule can resolve a login ticket over
   *  the same connection (Swarm auth reuses the p4 session — see swarmAuth). */
  get p4Service(): P4Service {
    return this._p4
  }

  /** The p4 user this client authenticates as (for Swarm Basic auth). */
  get user(): string | undefined {
    return this._p4.connection?.user
  }

  /**
   * Ensure a changelist is a numbered, shelved change ready for Swarm review, and
   * return its numbered id. The default changelist can't be shelved directly, so
   * its files are first moved into a fresh numbered changelist (using `description`
   * or a placeholder). Then `p4 shelve -r -c <id>` (re)shelves. Returns undefined
   * on failure (surfaced via toast by `shelve`/`moveToNewChangelist`).
   */
  async shelveForReview(changelist: string, description?: string): Promise<string | undefined> {
    let target = changelist
    if (target === 'default') {
      const paths = this.pathsInChangelist('default')
      if (paths.length === 0) return undefined
      const created = await this.moveToNewChangelist(description?.trim() || 'Review', paths)
      if (!created) return undefined
      target = created
    }
    const ok = await this.shelve(target)
    return ok ? target : undefined
  }
  async describeChangeFiles(
    change: string,
    force = false,
    immutable = false,
  ): Promise<
    {
      status: string
      path: string
      depotFile: string
      localPath: string | null
      baseRevision: string | null
    }[]
  > {
    // An archive shelf is a permanent, content-addressed snapshot: cache it
    // forever and never let a caller's `force` re-run p4 on it. Only a mutable
    // pending shelf (the author's changelist, re-shelvable in place) uses the
    // short-TTL namespace + force invalidation.
    const ns = immutable ? P4CacheNs.archiveDescribe : P4CacheNs.shelvedDescribe
    if (force && !immutable) this._cache.invalidate(P4CacheNs.shelvedDescribe, change)
    const cached = await this._cache.wrap(ns, change, async () => {
      // Expanding a Swarm review's file list is a click-triggered read, but
      // `describe -S -s` lists every file in the CL (GB-scale on a giant branch
      // CL) — priority-only, so it keeps the 600s budget rather than a 30s cap.
      const res = await this._p4.execRecords(
        ['describe', '-S', '-s', change],
        INTERACTIVE_CONTENT_EXEC,
      )
      if (res.result.exitCode !== 0) return undefined
      const record = res.records[0]
      if (!record) return undefined
      const detail = parseChangeDescribe(record)
      if (!detail) return undefined
      const localPaths = await this._whereLocalPaths(
        detail.files.map((file) => file.depotFile),
        INTERACTIVE_EXEC,
      )
      // `describe -S` reports each file's `rev` with a state-dependent meaning
      // (confirmed against a real server): for a SUBMITTED change the rev is the
      // revision that CONTAINS this edit (e.g. #18), so the pre-edit base is
      // #(rev-1); for a PENDING shelf the rev is already the pre-edit base (the
      // edit only lives in the shelf), so it's used as-is. Using `#rev` for a
      // submitted change made both diff sides the post-edit content (blank diff).
      const submitted = detail.status === 'submitted'
      const baseRevisionOf = (rev: string): string | null => {
        if (!submitted) return rev || null
        const n = Number(rev)
        return Number.isFinite(n) && n > 1 ? String(n - 1) : null
      }
      return JSON.stringify(
        detail.files.map((f) => {
          const status = statusFromAction(f.action)
          return {
            status,
            path: displayPath(f.depotFile),
            depotFile: f.depotFile,
            localPath: localPaths.get(f.depotFile) ?? null,
            baseRevision: status === 'A' ? null : baseRevisionOf(f.rev),
          }
        }),
      )
    })
    return cached === undefined
      ? []
      : (JSON.parse(cached) as {
          status: string
          path: string
          depotFile: string
          localPath: string | null
          baseRevision: string | null
        }[])
  }

  /**
   * Submitted-changelist history for the graph, newest-first, scoped to `scope`
   * (a p4 filespec — the opened workspace folder as `<path>/...` by default, or
   * the whole client depot `//...`). Each change's synthetic parent is the
   * next-older change in the list, so the swim-lane layout draws a single lane.
   * `pendingCount` is the number of currently open files (the synthetic pending
   * node). Returns null on connection failure so the renderer shows "unavailable".
   */
  async getGraphChanges(maxChanges: number, scope: string): Promise<GraphChangeMeta[] | null> {
    const json = await this._cache.wrap(
      P4CacheNs.changesSubmitted,
      `${scope}:${maxChanges}`,
      async () => {
        const res = await this._p4.execRecords(
          ['changes', '-s', 'submitted', '-l', '-m', String(maxChanges + 1), scope],
          INTERACTIVE_EXEC,
        )
        if (res.result.exitCode !== 0) return undefined
        return JSON.stringify(parseChangesList(res.records))
      },
    )
    return json === undefined ? null : (JSON.parse(json) as GraphChangeMeta[])
  }

  /** Count files currently open in the workspace (the synthetic pending node). */
  async getPendingCount(): Promise<number> {
    return (await this._openedFiles()).length
  }

  /**
   * `p4 fstat` for one local file: depot path, have/head revisions, and the open
   * action (undefined when not open). Returns undefined when the file is not
   * under depot control (or the query fails) — the Timeline provider treats that
   * as "not ours" and stays silent for the file.
   */
  async fstat(localPath: string): Promise<FstatInfo | undefined> {
    return this._baseline.getFstatInfo(localPath)
  }

  /**
   * The user's clients (`p4 clients`), for the switch-workspace quick-pick.
   * Runs on this client's connection, so the `-u` global pins the user the
   * client resolved — the cwd P4CONFIG at a foreign root can't re-resolve it.
   * Empty on failure (offline / not logged in); the caller surfaces that.
   */
  async listUserClients(): Promise<P4ClientEntry[]> {
    const { result, records } = await this._p4.execRecords(['clients'], INTERACTIVE_EXEC)
    if (result.exitCode !== 0) {
      this._log?.(
        `[perforce] p4 clients failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}; cannot list clients`,
      )
      return []
    }
    return parseClientsList(records)
  }

  /**
   * One page of a file's revision history (`p4 filelog -m <max> <depotFile>`,
   * newest-first). `fromRev` bounds the page from above (`<depotFile>#<fromRev>`),
   * which is how the Timeline view pages backwards without re-resolving the
   * depot path. Empty array on failure (e.g. an open-for-add file with no depot
   * history yet). Cached with the workspace TTL — the Timeline view re-pulls the
   * first page on every active-editor switch, and history only grows on
   * submit/sync (which `_mutate` invalidates).
   */
  async getFilelog(depotFile: string, max: number, fromRev?: number): Promise<FilelogRevision[]> {
    const spec = fromRev !== undefined ? `${depotFile}#${fromRev}` : depotFile
    const json = await this._cache.wrap(P4CacheNs.filelog, `${spec}:${max}`, async () => {
      const res = await this._p4.execRecords(['filelog', '-m', String(max), spec], INTERACTIVE_EXEC)
      if (res.result.exitCode !== 0) return undefined
      return JSON.stringify(parseFilelog(res.records))
    })
    return json === undefined ? [] : (JSON.parse(json) as FilelogRevision[])
  }

  /**
   * True when the working-tree content of an UNOPENED file differs from its have
   * revision (`p4 diff -se`) — the reconcile-drift case the Timeline "pending"
   * entry mirrors from git's uncommitted row. Opened files don't need this (their
   * fstat action already says so); an unopened clean file prints nothing.
   */
  async differsFromHave(localPath: string): Promise<boolean> {
    const res = await this._p4.exec(['diff', '-se', localPath], INTERACTIVE_EXEC)
    return res.exitCode === 0 && res.stdout.trim().length > 0
  }

  /**
   * Currently open files (across all pending changelists) as graph file entries,
   * with resolved local paths. Feeds the synthetic "pending changes" node — the
   * Perforce analogue of git's uncommitted-changes row.
   */
  async getOpenedForGraph(): Promise<
    {
      depotFile: string
      action: P4Action
      rev: string | undefined
      localPath: string | null
    }[]
  > {
    const opened = await this._openedFiles()
    const localByDepot = await this._whereLocalPaths(
      opened.map((f) => f.depotFile),
      INTERACTIVE_EXEC,
    )
    return opened.map((f) => ({
      depotFile: f.depotFile,
      action: f.action,
      rev: f.rev,
      localPath: f.clientFile ?? localByDepot.get(f.depotFile) ?? null,
    }))
  }

  /** Parsed `p4 opened` for the graph's pending consumers, cached (ttl) so the
   *  count and the file list share one round-trip. */
  private async _openedFiles(): Promise<ReturnType<typeof parseOpened>> {
    const json = await this._cache.wrap(P4CacheNs.opened, 'all', async () => {
      // Only the graph's pending-node consumers reach here (the refresh issues its
      // own `opened`), so this is always a click-triggered read.
      const res = await this._p4.execRecords(['opened'], INTERACTIVE_EXEC)
      if (res.result.exitCode !== 0) return undefined
      return JSON.stringify(parseOpened(res.records, this.root))
    })
    return json === undefined ? [] : (JSON.parse(json) as ReturnType<typeof parseOpened>)
  }

  /**
   * Full detail of one submitted change: metadata + changed files with resolved
   * local paths (via `p4 where`). Returns null when the change can't be described.
   *
   * A submitted change never changes, so `describe` is cached immutably (and
   * persisted across sessions). The depot→local resolution is separately cached
   * immutably per change id, but in memory only — the mapping depends on the
   * client view, which can differ across sessions, so it isn't persisted. This
   * keeps reopening a change a zero-round-trip cache hit within a session
   * (previously the `where` half re-ran on every open once its short TTL lapsed).
   */
  async getGraphChangeDetails(
    id: string,
  ): Promise<(GraphDescribe & { localPaths: Map<string, string> }) | null> {
    const json = await this._cache.wrap(P4CacheNs.describe, id, async () => {
      // `describe -s` lists every file in the CL — GB-scale on a giant branch CL —
      // so priority-only: a 30s interactive cap would kill a legitimate large change.
      const res = await this._p4.execRecords(['describe', '-s', id], INTERACTIVE_CONTENT_EXEC)
      if (res.result.exitCode !== 0) return undefined
      const record = res.records[0]
      if (!record) return undefined
      const detail = parseChangeDescribe(record)
      return detail ? JSON.stringify(detail) : undefined
    })
    if (json === undefined) return null
    const detail = JSON.parse(json) as GraphDescribe
    const localPaths = await this._changeLocalPaths(
      id,
      detail.files.map((f) => f.depotFile),
    )
    return { ...detail, localPaths }
  }

  /** Depot→local resolution for one submitted change's files, cached immutably
   *  (in memory, not persisted) per change id so reopening the change never
   *  re-runs `p4 where`. A submitted change's file set is fixed, so the mapping is
   *  stable for the session. */
  private async _changeLocalPaths(
    id: string,
    depotFiles: readonly string[],
  ): Promise<Map<string, string>> {
    if (depotFiles.length === 0) return new Map()
    const json = await this._cache.wrap(P4CacheNs.changeDetailPaths, id, async () => {
      const map = await this._whereLocalPaths(depotFiles, INTERACTIVE_EXEC)
      return JSON.stringify([...map])
    })
    return json === undefined ? new Map() : new Map(JSON.parse(json) as [string, string][])
  }

  /** Resolve depot → local paths for a batch of files (`p4 where`). Cached (ttl)
   *  keyed on the sorted depot-file set so repeated lookups reuse one query.
   *  Defaults to background priority — the one background caller is the
   *  apply-committed-change mutation; the graph/Swarm read callers pass
   *  {@link INTERACTIVE_EXEC} (a sub-second metadata read). */
  private async _whereLocalPaths(
    depotFiles: readonly string[],
    options?: P4ExecOptions,
  ): Promise<Map<string, string>> {
    return (await this._whereLocalPathsResult(depotFiles, options)).paths
  }

  /**
   * {@link _whereLocalPaths} with the failure surfaced. An empty map is
   * ambiguous on its own: `where` exits 0 with zero records when none of the
   * depot paths map into this client's view, which on a real shared server is
   * the common case rather than an error (files opened by others usually live on
   * other branches). A caller that treats "no local paths" as a failed lookup
   * would then never publish anything at all.
   */
  private async _whereLocalPathsResult(
    depotFiles: readonly string[],
    options?: P4ExecOptions,
  ): Promise<{ paths: Map<string, string>; ok: boolean }> {
    if (depotFiles.length === 0) return { paths: new Map(), ok: true }
    const key = [...depotFiles].sort().join('\n')
    const json = await this._cache.wrap(P4CacheNs.where, key, async () => {
      // Batch the depot paths so a large set (a changelist with tens of thousands
      // of files) can't overflow the OS command-line limit (`ENAMETOOLONG`); each
      // batch's records merge into one map. A failed batch fails the whole lookup.
      const merged = new Map<string, string>()
      for (const batch of chunkByLength(depotFiles)) {
        const res = await this._p4.execRecords(['where', ...batch], options)
        if (res.result.exitCode !== 0) return undefined
        for (const [depot, local] of parseWhereLocalPaths(res.records)) merged.set(depot, local)
      }
      return JSON.stringify([...merged])
    })
    if (json === undefined) return { paths: new Map(), ok: false }
    return { paths: new Map(JSON.parse(json) as [string, string][]), ok: true }
  }

  /**
   * Print a file revision's content (`p4 print -q <spec>`) for the diff editor,
   * or empty string when the spec is null (an added/deleted side) or print fails.
   * A concrete `#revision` is immutable and cached. A pending shelf selected by
   * `@=change` can be replaced in place, so it must bypass the persistent cache —
   * unless the caller marks it `immutable` (a Swarm archive shelf, which is a
   * content-addressed snapshot that can never be re-shelved).
   */
  async printRevision(spec: string | null, immutable = false): Promise<string> {
    if (!spec) return ''
    return (await this.printRevisionResult(spec, immutable)).content
  }

  /**
   * {@link printRevision} variant that reports WHY the content is empty, for the
   * Swarm review diff: a genuinely empty revision and a failed print must not be
   * indistinguishable (an empty string fed to the renderer's size-based routing
   * reads as a 0-byte file).
   */
  async printRevisionResult(
    spec: string,
    immutable = false,
  ): Promise<{ content: string; error?: string }> {
    // Read via depot syntax with no client (`noClient`), so a file not mapped in
    // the current client's view still prints — the out-of-workspace Swarm diff
    // case. A shelf spec (`@=change`) can be re-shelved in place, so it bypasses
    // the persistent cache; a concrete `#revision` is immutable and cached.
    if (!immutable && spec.includes('@=')) {
      const res = await this._p4.exec(['print', '-q', spec], {
        ...INTERACTIVE_CONTENT_EXEC,
        noClient: true,
      })
      if (res.exitCode !== 0) {
        this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
        return {
          content: '',
          error: firstStderrLine(res.stderr) ?? `p4 print failed (exit ${res.exitCode})`,
        }
      }
      return { content: res.stdout }
    }
    const { value, error } = await this._cache.wrapWithError(P4CacheNs.print, spec, async () => {
      this._log?.(`[perforce] print ${spec} (cache miss, p4 print)`)
      const res = await this._p4.exec(['print', '-q', spec], {
        ...INTERACTIVE_CONTENT_EXEC,
        noClient: true,
      })
      if (res.exitCode !== 0) {
        this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
        // Failures stay out of the print cache — a transient p4 failure must be
        // retried on the next request, not replayed forever.
        return { error: firstStderrLine(res.stderr) ?? `p4 print failed (exit ${res.exitCode})` }
      }
      return { value: res.stdout }
    })
    if (value !== undefined) return { content: value }
    return { content: '', error: error ?? 'p4 print failed' }
  }

  /**
   * Print a file revision's content as raw bytes (`p4 print -q <spec>`), for
   * binary files (e.g. xlsx) that UTF-8 decoding would corrupt. Returns an empty
   * buffer when the spec is null (an added/deleted side) or print fails. Like
   * `printRevision`, a pending `@=change` shelf bypasses the cache unless the
   * caller marks it `immutable`; cached bytes are base64-encoded into the string
   * cache under a `bytes:` key prefix so they never collide with decoded text.
   */
  async printRevisionBytes(spec: string | null, immutable = false): Promise<Buffer> {
    if (!spec) return Buffer.alloc(0)
    return (await this.printRevisionBytesResult(spec, immutable)).bytes
  }

  /**
   * {@link printRevisionBytes} variant that reports WHY the bytes are empty — see
   * {@link printRevisionResult}.
   */
  async printRevisionBytesResult(
    spec: string,
    immutable = false,
  ): Promise<{ bytes: Buffer; error?: string }> {
    const fetch = async (): Promise<{ bytes?: Buffer; error?: string }> => {
      const res = await this._p4.execBinary(['print', '-q', spec], {
        ...INTERACTIVE_CONTENT_EXEC,
        noClient: true,
      })
      if (res.exitCode !== 0) {
        this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
        // Failures stay out of the print cache — a transient p4 failure must be
        // retried on the next request, not replayed forever.
        return { error: firstStderrLine(res.stderr) ?? `p4 print failed (exit ${res.exitCode})` }
      }
      return { bytes: res.stdout }
    }
    if (!immutable && spec.includes('@=')) {
      const { bytes, error } = await fetch()
      if (error !== undefined || bytes === undefined)
        return { bytes: Buffer.alloc(0), error: error ?? 'p4 print failed' }
      return { bytes }
    }
    const { value, error } = await this._cache.wrapWithError(
      P4CacheNs.print,
      `bytes:${spec}`,
      async () => {
        this._log?.(`[perforce] print ${spec} (cache miss, p4 print bytes)`)
        const { bytes, error: fetchError } = await fetch()
        if (fetchError !== undefined || bytes === undefined)
          return { error: fetchError ?? 'p4 print failed' }
        return { value: bytes.toString('base64') }
      },
    )
    if (value === undefined) return { bytes: Buffer.alloc(0), error: error ?? 'p4 print failed' }
    return { bytes: Buffer.from(value, 'base64') }
  }

  /**
   * Start a low-frequency background refresh every `seconds` (0 / negative
   * disables). Perforce state lives on the server with no FS watcher, so polling
   * is the only way to catch changes made outside the editor — kept opt-in and
   * infrequent (default off) so it doesn't hammer the server. A minimum floor of
   * 10s guards against a misconfigured tiny interval.
   */
  startPolling(seconds: number): void {
    this.stopPolling()
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const ms = Math.max(10, seconds) * 1000
    this._pollTimer = setInterval(() => {
      if (!this._disposed) void this.refresh()
    }, ms)
    this._log?.(`[perforce] polling ${this._clientName} every ${Math.round(ms / 1000)}s`)
  }

  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = undefined
    }
  }

  dispose(): void {
    this._disposed = true
    this.stopPolling()
    this._cache.clear()
    for (const live of this._groups.values()) live.dispose()
    this._groups.clear()
    this._reconcileGroup.dispose()
    this._resolveGroup.dispose()
    this._sc.dispose()
    this._changeListeners.clear()
  }
}
