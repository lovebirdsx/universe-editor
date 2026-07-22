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
  type Command,
  type Disposable,
  type QuickPickItem,
  type SourceControl,
  type SourceControlResourceGroup,
  type SourceControlResourceState,
} from '@universe-editor/extension-api'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConcurrencyGate } from './concurrency.js'
import { P4Service, chunkByLength, type P4Connection, type P4ExecResult } from './p4Service.js'
import { discoverClient, connectionFor, type DiscoveredClient } from './clientDiscovery.js'
import { parseOpened, parsePending } from './openedParser.js'
import {
  groupChangelists,
  countOpened,
  changelistIdFromGroupId,
  descriptionFirstLine,
  shelvedGroupId,
  RECONCILE_GROUP_ID,
  type PendingChangelist,
  type P4Action,
} from './changelist.js'
import {
  toResourceStates,
  toShelvedResourceStates,
  toReconcileResourceStates,
} from './p4Decoration.js'
import { parseShelved, type ShelvedFile } from './shelveParser.js'
import {
  parseReconcile,
  mergeReconcile,
  filterDismissed,
  expandDismissPaths,
  type ReconcileFile,
} from './reconcileParser.js'
import { norm } from './pathUtil.js'
import { buildNewChangeSpec, replaceDescription, parseDescription } from './changeSpec.js'
import {
  parseAnnotate,
  annotatedChangelists,
  buildBlameResult,
  type P4BlameResult,
} from './blameSource.js'
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
import { classifyP4Error, notifyP4Failure, type P4FailureKind } from './p4Error.js'
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
  /** Label of a long-running p4 operation in flight (e.g. "Submitting"), or
   *  undefined when idle. Drives the status-bar spinner. */
  readonly busy: string | undefined
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

/** True when a path is a spreadsheet the Excel extension should diff in a webview. */
function isSpreadsheetPath(path: string): boolean {
  const lower = path.toLowerCase()
  return SPREADSHEET_EXTS.some((ext) => lower.endsWith(ext))
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
  /** Depot/local scope the reconcile-discovery pass covers. Defaults to the whole
   *  client (`//...`); narrowed to the opened folder so a huge depot isn't scanned
   *  on every refresh (see {@link setReconcileScope}). */
  private _reconcileScope = '//...'
  private _disposed = false
  private _pollTimer: ReturnType<typeof setInterval> | undefined
  /** Whether Swarm is enabled + configured, so the commit bar offers "Request New
   *  Swarm Review…" as the default submit action. Set from config at activate. */
  private _swarmAvailable = false
  /** Labels of in-flight long-running p4 operations (a stack so overlapping ops
   *  keep the spinner up until the last one finishes). */
  private readonly _busyOps: string[] = []

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
    this._cache = new P4Cache(cacheOptions.now ?? Date.now, cacheOptions.disk, cacheOptions.enabled)
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
    this._sc.inputBox.placeholder = localize(
      'perforce.input.placeholder',
      'Message for the default changelist',
    )
    this._sc.acceptInputCommand = {
      command: 'perforce.submitDefault',
      title: localize('perforce.command.submit.title', 'Submit'),
    }
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
      busy: this._busyOps[this._busyOps.length - 1],
    }
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
   * `perforce.autoReconcile`), a `p4 reconcile -n` pass also runs to populate the
   * "changes to reconcile" group. That pass can be heavy on a large workspace, so
   * ordinary post-mutation refreshes leave it off unless it's already sticky.
   * Pass `{ reconcile: true }` to force the pass on (and make it sticky).
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

  /** Narrow the reconcile-discovery scan to `localPath` (the opened folder) so a
   *  huge depot isn't walked as `//...` on every refresh. A local filesystem path
   *  is passed to p4 as `<path>/...`; `undefined` restores the whole-client `//...`
   *  default. */
  setReconcileScope(localPath: string | undefined): void {
    if (!localPath) {
      this._reconcileScope = '//...'
      return
    }
    const trimmed = localPath.replace(/[/\\]+$/, '')
    this._reconcileScope = `${trimmed}/...`
  }

  private async _doRefresh(): Promise<void> {
    const opened = await this._p4.execRecords(['opened'])
    if (this._disposed) return
    if (opened.result.exitCode !== 0) {
      this._goOffline(classifyP4Error(opened.result))
      return
    }
    const changes = await this._p4.execRecords(['changes', '-s', 'pending', '-c', this._clientName])
    if (this._disposed) return
    if (changes.result.exitCode !== 0) {
      this._goOffline(classifyP4Error(changes.result))
      return
    }

    this._connection = 'connected'
    const openedFiles = parseOpened(opened.records, this.root)
    const pending = parsePending(changes.records)
    this._pending = pending
    const groups = groupChangelists(openedFiles, pending, {
      default: () => localize('perforce.group.defaultShort', 'Default'),
      numbered: (id, firstLine) =>
        firstLine
          ? localize('perforce.group.numbered', '#{0}: {1}', { 0: id, 1: firstLine })
          : localize('perforce.group.numberedNoDesc', '#{0}', { 0: id }),
    })

    // Fetch shelved files for numbered changelists that report `shelved` in the
    // pending list, and interleave a shelved sub-group after each owning CL.
    const shelvedByCl = await this._fetchShelved(pending)
    if (this._disposed) return

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
      openedFiles
        .map((f) => (f.clientFile ? norm(f.clientFile) : undefined))
        .filter(Boolean) as string[],
    )
    this._changelistByPath = new Map(
      openedFiles
        .filter((f) => f.clientFile)
        .map((f) => [norm(f.clientFile!), f.changelist] as const),
    )
    const fullScan = this._fullScanRequested || this._autoReconcile
    this._fullScanRequested = false
    await this._refreshReconcile(fullScan)
    if (this._disposed) return
    this._openedCount = countOpened(groups)
    this._sc.count = this._openedCount
    const defaultHasFiles = groups.some((g) => g.isDefault && g.files.length > 0)
    this._sc.acceptInputActions = defaultHasFiles ? this._buildAcceptActions() : undefined
    this._emitChange()
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

  /** Fetch shelved files for each pending numbered changelist that has any,
   *  keyed by changelist id. Failures per-CL are logged and skipped so one bad
   *  describe doesn't sink the whole refresh. */
  private async _fetchShelved(
    pending: readonly { id: string; description: string }[],
  ): Promise<Map<string, ShelvedFile[]>> {
    const out = new Map<string, ShelvedFile[]>()
    for (const cl of pending) {
      const res = await this._p4.execRecords(['describe', '-S', '-s', cl.id])
      if (this._disposed) return out
      if (res.result.exitCode !== 0) {
        this._log?.(`[perforce] describe -S ${cl.id} failed: ${res.result.stderr.trim()}`)
        continue
      }
      const shelved = parseShelved(res.records)
      if (shelved.length > 0) out.set(cl.id, shelved)
    }
    return out
  }

  /**
   * Refresh the "changes to reconcile" group during a full workspace refresh.
   *
   * When discovery is inactive the group is emptied (hidden). With `fullScan` on
   * (clean refresh / `perforce.autoReconcile`) it runs a full `reconcile -n -a -e -d
   * <scope>` walk — heavy on large trees, so only on demand. Otherwise (an ordinary
   * post-mutation refresh) it re-filters the cached list against the freshly fetched
   * opened set AND re-verifies each surviving entry against disk with an incremental
   * `reconcile -n` over just those paths — so an entry whose change was discarded
   * (edited back / disk-add deleted / disk-delete restored) drops out without
   * walking the whole tree.
   *
   * `p4 reconcile -n` is a dry run — it never mutates server state (collecting a
   * file is a separate real `reconcile`). Files already opened are filtered out
   * (their disk edits are tracked in a changelist group). A failed walk logs and
   * clears the group rather than sinking the whole refresh.
   */
  private async _refreshReconcile(fullScan: boolean): Promise<void> {
    if (!this._reconcileActive) {
      this._setReconcileFiles([])
      return
    }
    if (!fullScan) {
      // Cheap path: no whole-tree walk. First drop cached entries that are now
      // opened (e.g. just collected). Then re-verify the surviving entries against
      // disk with an incremental `reconcile -n` over just those paths (O(list
      // size), not O(tree)) so an entry whose change was discarded — edited back
      // to the have revision, a disk-add deleted, a disk-delete restored — drops
      // out automatically. An empty list makes zero p4 calls.
      const candidates = this._reconcileFiles.filter(
        (f) => !f.clientFile || !this._openedPaths.has(norm(f.clientFile)),
      )
      const paths = candidates.map((f) => f.clientFile).filter((p): p is string => p !== undefined)
      if (paths.length === 0) {
        this._setReconcileFiles(candidates)
        return
      }
      const { scanned, fresh } = await this._rescanReconcilePaths(paths)
      if (this._disposed) return
      this._setReconcileFiles(mergeReconcile(candidates, scanned, fresh))
      return
    }
    const res = await this._p4.execRecords([
      'reconcile',
      '-n',
      '-a',
      '-e',
      '-d',
      this._reconcileScope,
    ])
    if (this._disposed) return
    if (res.result.exitCode !== 0) {
      // `reconcile -n` exits non-zero with "no file(s) to reconcile" when the
      // tree is clean — that's not an error, just an empty result.
      const stderr = res.result.stderr.toLowerCase()
      if (!stderr.includes('no file(s) to reconcile') && !stderr.includes('- no such file')) {
        this._log?.(`[perforce] reconcile -n failed: ${res.result.stderr.trim()}`)
      }
      this._setReconcileFiles([])
      return
    }
    const files = parseReconcile(res.records, this.root).filter(
      (f) => !f.clientFile || !this._openedPaths.has(norm(f.clientFile)),
    )
    this._setReconcileFiles(files)
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
   */
  async refreshReconcilePaths(paths: readonly string[]): Promise<void> {
    if (this._disposed || paths.length === 0) return
    await this._runSerial(async () => {
      if (this._disposed) return
      this._reconcileActive = true
      const { scanned, fresh } = await this._rescanReconcilePaths(paths)
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
   * Deliberately does NOT enter the serial chain or touch shared state — callers
   * own ordering (via {@link _runSerial}) and merging, so it's safe to invoke
   * from inside an already-serialized refresh (the cheap re-verify path).
   */
  private async _rescanReconcilePaths(
    paths: readonly string[],
  ): Promise<{ scanned: string[]; fresh: ReconcileFile[] }> {
    const batches = chunkByLength(paths)
    const fresh: ReconcileFile[] = []
    const scanned: string[] = []
    for (const batch of batches) {
      const res = await this._p4.execRecords(['reconcile', '-n', '-a', '-e', '-d', ...batch])
      if (this._disposed) return { scanned, fresh }
      if (res.result.exitCode === 0) {
        for (const f of parseReconcile(res.records, this.root)) {
          if (!f.clientFile || !this._openedPaths.has(norm(f.clientFile))) fresh.push(f)
        }
        scanned.push(...batch)
      } else {
        const stderr = res.result.stderr.toLowerCase()
        if (stderr.includes('no file(s) to reconcile') || stderr.includes('- no such file')) {
          scanned.push(...batch)
        } else {
          this._log?.(`[perforce] incremental reconcile -n failed: ${res.result.stderr.trim()}`)
        }
      }
    }
    return { scanned, fresh }
  }

  /** Set the reconcile file list and mirror it into the group's resource states.
   *  Dismissed files are filtered out here so every producer (full scan, cheap
   *  re-filter, incremental merge, restore) is uniformly clean, then the result
   *  is persisted so it survives a reload without a fresh scan. */
  private _setReconcileFiles(files: readonly ReconcileFile[]): void {
    const visible = filterDismissed(files, this._dismissed)
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
    this._openedCount = 0
    this._sc.count = 0
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
   * succeeded. Empty `paths` is a no-op (nothing selected).
   */
  private async _mutate(
    label: string,
    args: readonly string[],
    paths: readonly string[] = [],
  ): Promise<boolean> {
    if (args.length === 0) return false
    return this._withBusy(this._busyLabel(label), async () => {
      const result = await this._p4.exec([...args, ...paths])
      if (result.exitCode !== 0) {
        await notifyP4Failure(label, result)
        await this.refresh()
        return false
      }
      this._cache.invalidateWorkspace()
      await this.refresh()
      return true
    })
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

  // --- Resolve (Phase 3) ---------------------------------------------------

  /**
   * Auto-resolve files with the safe merge strategy (`p4 resolve -am`): accepts
   * clean automatic merges, leaves genuine conflicts open for manual handling
   * (reported back via the toast + a refresh so the `U` rows stay visible).
   */
  async resolve(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    return this._mutate('resolve', ['resolve', '-am'], paths)
  }

  /** Auto-resolve every unresolved file in a numbered changelist. */
  async resolveChangelist(changelist: string): Promise<boolean> {
    if (changelist === 'default') return this._mutate('resolve', ['resolve', '-am'])
    return this._mutate('resolve', ['resolve', '-am', '-c', changelist])
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
   * there's no have revision (e.g. open-for-add).
   */
  async openChange(localPath: string, pinned = false, preserveFocus = false): Promise<void> {
    if (isSpreadsheetPath(localPath)) {
      await this._openSpreadsheetChange(localPath, pinned, preserveFocus)
      return
    }
    const baseline = await this._baseline.getHaveContent(localPath)
    if (baseline === undefined) {
      await commands.executeCommand('_workbench.openFile', localPath)
      return
    }
    let modified = ''
    try {
      modified = await readFile(localPath, 'utf8')
    } catch {
      modified = '' // deleted on disk
    }
    await commands.executeCommand('_workbench.openDiff', {
      title: `${basename(localPath)} (Perforce)`,
      originalUri: pathToFileURL(localPath).href,
      original: baseline,
      modified,
      pinned,
      preserveFocus,
      openableUri: pathToFileURL(localPath).href,
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
    const baseline = await this._baseline.getHaveContentBytes(localPath)
    if (baseline === undefined) {
      await commands.executeCommand('_workbench.openFile', localPath)
      return
    }
    let modified: Buffer
    try {
      modified = await readFile(localPath)
    } catch {
      modified = Buffer.alloc(0) // deleted on disk
    }
    await commands.executeCommand('_workbench.openWebviewDiff', {
      viewType: 'universe.excel',
      title: `${basename(localPath)} (Perforce)`,
      leftUri: pathToFileURL(localPath).href,
      rightUri: pathToFileURL(localPath).href,
      leftBase64: baseline.toString('base64'),
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
   * `p4 annotate -c -q`, then batches `describe` for each changelist's summary.
   * Contributed to the host as `perforce.getBlame`.
   *
   * Both use `-ztag`, not `-Mj`: on some servers (observed on P4D 2024.2) the
   * JSON output collapses every line into a single `data` blob and drops the
   * structured fields (`lower`/`upper`/`user`/`time`/`desc`) the parsers need —
   * only tagged output carries them. `-u` is omitted because its per-line `time`
   * is a display date, not Unix seconds; author/time come from `describe` instead.
   */
  async getBlame(localPath: string): Promise<P4BlameResult | null> {
    const annotate = await this._p4.execTagged(['annotate', '-c', '-q', localPath])
    if (annotate.result.exitCode !== 0) return null
    const lines = parseAnnotate(annotate.records)
    if (lines.length === 0) return null

    const summaries = new Map<string, { summary: string; user?: string; time?: number }>()
    for (const cl of annotatedChangelists(lines)) {
      const json = await this._cache.wrap(P4CacheNs.describe, `summary:${cl}`, async () => {
        const desc = await this._p4.execTagged(['describe', '-s', cl])
        if (desc.result.exitCode !== 0) return undefined
        const record = desc.records[0]
        if (!record) return undefined
        const raw = typeof record['desc'] === 'string' ? record['desc'] : ''
        const user = typeof record['user'] === 'string' ? record['user'] : undefined
        const timeSec = typeof record['time'] === 'string' ? record['time'] : undefined
        return JSON.stringify({
          summary: descriptionFirstLine(raw),
          ...(user ? { user } : {}),
          ...(timeSec ? { time: Number(timeSec) * 1000 } : {}),
        })
      })
      if (json === undefined) continue
      summaries.set(
        cl,
        json
          ? (JSON.parse(json) as { summary: string; user?: string; time?: number })
          : { summary: '' },
      )
    }

    return buildBlameResult(lines, summaries)
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
      const res = await this._p4.execRecords(['describe', '-S', '-s', change])
      if (res.result.exitCode !== 0) return undefined
      const record = res.records[0]
      if (!record) return undefined
      const detail = parseChangeDescribe(record)
      if (!detail) return undefined
      const localPaths = await this._whereLocalPaths(detail.files.map((file) => file.depotFile))
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
        const res = await this._p4.execRecords([
          'changes',
          '-s',
          'submitted',
          '-l',
          '-m',
          String(maxChanges + 1),
          scope,
        ])
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
   * Currently open files (across all pending changelists) as graph file entries,
   * with resolved local paths. Feeds the synthetic "pending changes" node — the
   * Perforce analogue of git's uncommitted-changes row.
   */
  async getOpenedForGraph(): Promise<
    { depotFile: string; action: P4Action; rev: string | undefined; localPath: string | null }[]
  > {
    const opened = await this._openedFiles()
    const localByDepot = await this._whereLocalPaths(opened.map((f) => f.depotFile))
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
      const res = await this._p4.execRecords(['opened'])
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
      const res = await this._p4.execRecords(['describe', '-s', id])
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
      const map = await this._whereLocalPaths(depotFiles)
      return JSON.stringify([...map])
    })
    return json === undefined ? new Map() : new Map(JSON.parse(json) as [string, string][])
  }

  /** Resolve depot → local paths for a batch of files (`p4 where`). Cached (ttl)
   *  keyed on the sorted depot-file set so repeated lookups reuse one query. */
  private async _whereLocalPaths(depotFiles: readonly string[]): Promise<Map<string, string>> {
    if (depotFiles.length === 0) return new Map()
    const key = [...depotFiles].sort().join('\n')
    const json = await this._cache.wrap(P4CacheNs.where, key, async () => {
      // Batch the depot paths so a large set (a changelist with tens of thousands
      // of files) can't overflow the OS command-line limit (`ENAMETOOLONG`); each
      // batch's records merge into one map. A failed batch fails the whole lookup.
      const merged = new Map<string, string>()
      for (const batch of chunkByLength(depotFiles)) {
        const res = await this._p4.execRecords(['where', ...batch])
        if (res.result.exitCode !== 0) return undefined
        for (const [depot, local] of parseWhereLocalPaths(res.records)) merged.set(depot, local)
      }
      return JSON.stringify([...merged])
    })
    return json === undefined ? new Map() : new Map(JSON.parse(json) as [string, string][])
  }

  /**
   * Print a file revision's content (`p4 print -q <spec>`) for the diff editor,
   * or empty string when the spec is null (an added/deleted side) or print fails.
   * A concrete `#revision` is immutable and cached. A pending shelf selected by
   * `@=change` can be replaced in place, so it must bypass the persistent cache.
   */
  async printRevision(spec: string | null): Promise<string> {
    if (!spec) return ''
    // Read via depot syntax with no client (`noClient`), so a file not mapped in
    // the current client's view still prints — the out-of-workspace Swarm diff
    // case. A shelf spec (`@=change`) can be re-shelved in place, so it bypasses
    // the persistent cache; a concrete `#revision` is immutable and cached.
    if (spec.includes('@=')) {
      const res = await this._p4.exec(['print', '-q', spec], { noClient: true })
      if (res.exitCode !== 0) {
        this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
        return ''
      }
      return res.stdout
    }
    const value = await this._cache.wrap(P4CacheNs.print, spec, async () => {
      const res = await this._p4.exec(['print', '-q', spec], { noClient: true })
      if (res.exitCode !== 0) {
        this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
        return undefined
      }
      return res.stdout
    })
    return value ?? ''
  }

  /**
   * Print a file revision's content as raw bytes (`p4 print -q <spec>`), for
   * binary files (e.g. xlsx) that UTF-8 decoding would corrupt. Not cached (the
   * string `print` cache stores decoded text); returns an empty buffer when the
   * spec is null (an added/deleted side) or print fails.
   */
  async printRevisionBytes(spec: string | null): Promise<Buffer> {
    if (!spec) return Buffer.alloc(0)
    const res = await this._p4.execBinary(['print', '-q', spec], { noClient: true })
    if (res.exitCode !== 0) {
      this._log?.(`[perforce] print ${spec} failed (exit ${res.exitCode}): ${res.stderr.trim()}`)
      return Buffer.alloc(0)
    }
    return res.stdout
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
    this._sc.dispose()
    this._changeListeners.clear()
  }
}
