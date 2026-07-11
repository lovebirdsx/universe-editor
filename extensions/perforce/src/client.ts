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
import { P4Service, type P4Connection, type P4ExecResult } from './p4Service.js'
import { discoverClient, connectionFor, type DiscoveredClient } from './clientDiscovery.js'
import { parseOpened, parsePending } from './openedParser.js'
import {
  groupChangelists,
  countOpened,
  changelistIdFromGroupId,
  descriptionFirstLine,
  shelvedGroupId,
  type PendingChangelist,
  type P4Action,
} from './changelist.js'
import { toResourceStates, toShelvedResourceStates } from './p4Decoration.js'
import { parseShelved, type ShelvedFile } from './shelveParser.js'
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
}

export type ConnectionState = 'connected' | 'offline' | 'not-logged-in'

export interface ClientStatus {
  readonly clientName: string
  readonly connection: ConnectionState
}

export interface P4CacheOptions {
  readonly enabled: boolean
  readonly workspaceTtlMs: number
  readonly disk?: P4CacheDiskBackend
}

export class PerforceClient {
  private readonly _p4: P4Service
  private readonly _sc: SourceControl
  private readonly _cache: P4Cache
  private readonly _baseline: BaselineProvider
  /** Live groups by group id (default / cl:<n>), so refresh can reuse or drop. */
  private readonly _groups = new Map<string, SourceControlResourceGroup>()
  private readonly _changeListeners = new Set<() => void>()
  /** Pending numbered changelists from the last refresh, for reopen quick-picks. */
  private _pending: readonly PendingChangelist[] = []
  private _connection: ConnectionState = 'connected'
  private _refreshing = false
  private _queued = false
  private _disposed = false
  private _pollTimer: ReturnType<typeof setInterval> | undefined

  private constructor(
    readonly root: string,
    private readonly _clientName: string,
    connection: P4Connection,
    gate: ConcurrencyGate,
    cacheOptions: P4CacheOptions,
    private readonly _log?: (msg: string) => void,
  ) {
    this._p4 = new P4Service(root, gate, connection, _log)
    this._cache = new P4Cache(Date.now, cacheOptions.disk, cacheOptions.enabled)
    registerP4CacheNamespaces(this._cache, cacheOptions.workspaceTtlMs)
    this._baseline = new BaselineProvider(this._p4, this._cache)
    this._sc = scm.createSourceControl('perforce', `Perforce: ${_clientName}`, root)
    this._sc.inputBox.placeholder = localize(
      'perforce.input.placeholder',
      'Description (used on submit)',
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
    )
  }

  get status(): ClientStatus {
    return { clientName: this._clientName, connection: this._connection }
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
   * rebuild the groups. Lightweight — server metadata queries only, no `status`/
   * `reconcile` (those are heavy and stay explicit). Coalesces concurrent calls.
   */
  async refresh(): Promise<void> {
    if (this._refreshing) {
      this._queued = true
      return
    }
    this._refreshing = true
    try {
      do {
        this._queued = false
        await this._doRefresh()
      } while (this._queued && !this._disposed)
    } finally {
      this._refreshing = false
    }
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
    const openedFiles = parseOpened(opened.records)
    const pending = parsePending(changes.records)
    this._pending = pending
    const groups = groupChangelists(openedFiles, pending, {
      default: () => localize('perforce.group.default', 'Default Changelist'),
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
        hideWhenEmpty: !group.isDefault,
        states: toResourceStates(group.files),
      })
      const clId = changelistIdFromGroupId(group.id)
      const shelved = shelvedByCl.get(clId)
      if (shelved && shelved.length > 0) {
        desired.push({
          id: shelvedGroupId(clId),
          label: localize('perforce.group.shelved', 'Shelved Files'),
          hideWhenEmpty: true,
          states: toShelvedResourceStates(shelved),
        })
      }
    }

    this._applyGroups(desired)
    this._sc.count = countOpened(groups)
    const defaultHasFiles = groups.some((g) => g.isDefault && g.files.length > 0)
    this._sc.acceptInputActions = defaultHasFiles
      ? [
          {
            command: 'perforce.submitDefault',
            title: localize('perforce.command.submit.title', 'Submit'),
            icon: 'check',
          },
          {
            command: 'perforce.revertUnchanged',
            title: localize('perforce.command.revertUnchanged.title', 'Revert Unchanged'),
            icon: 'discard',
          },
        ]
      : undefined
    this._emitChange()
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

  /** Reconcile the live ResourceGroups with the freshly computed groups: create
   *  new ones, update existing, dispose those that vanished. */
  private _applyGroups(groups: readonly DesiredGroup[]): void {
    const seen = new Set<string>()
    for (const group of groups) {
      seen.add(group.id)
      let live = this._groups.get(group.id)
      if (!live) {
        live = this._sc.createResourceGroup(group.id, group.label)
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
    const result = await this._p4.exec([...args, ...paths])
    if (result.exitCode !== 0) {
      await notifyP4Failure(label, result)
      await this.refresh()
      return false
    }
    this._cache.invalidateWorkspace()
    await this.refresh()
    return true
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

  /** Revert files — discards the open state and restores the have revision. */
  async revert(paths: readonly string[]): Promise<boolean> {
    return this._mutate('revert', ['revert'], paths)
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

  /** Shelve a changelist's open files (`p4 shelve -c <id>`), leaving them open. */
  async shelve(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('shelve', ['shelve', '-r', '-c', changelist])
  }

  /** Restore shelved files into the workspace (`p4 unshelve -s <id>`). */
  async unshelve(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('unshelve', ['unshelve', '-s', changelist, '-c', changelist, '-f'])
  }

  /** Delete a changelist's shelved files from the server (`p4 shelve -d`). */
  async deleteShelved(changelist: string): Promise<boolean> {
    if (changelist === 'default') return false
    return this._mutate('delete shelved', ['shelve', '-d', '-c', changelist])
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
   * Open a diff of `localPath`: left = the have-revision content from the depot,
   * right = the local file content. Falls back to just opening the file when
   * there's no have revision (e.g. open-for-add).
   */
  async openChange(localPath: string): Promise<void> {
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
      pinned: false,
      preserveFocus: false,
      openableUri: pathToFileURL(localPath).href,
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

  /**
   * Submitted-changelist history for the graph, newest-first, scoped to this
   * client's depot view (`//...`). Each change's synthetic parent is the
   * next-older change in the list, so the swim-lane layout draws a single lane.
   * `pendingCount` is the number of currently open files (the synthetic pending
   * node). Returns null on connection failure so the renderer shows "unavailable".
   */
  async getGraphChanges(maxChanges: number): Promise<GraphChangeMeta[] | null> {
    const json = await this._cache.wrap(
      P4CacheNs.changesSubmitted,
      String(maxChanges),
      async () => {
        const res = await this._p4.execRecords([
          'changes',
          '-s',
          'submitted',
          '-l',
          '-m',
          String(maxChanges + 1),
          '//...',
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
      return JSON.stringify(parseOpened(res.records))
    })
    return json === undefined ? [] : (JSON.parse(json) as ReturnType<typeof parseOpened>)
  }

  /**
   * Full detail of one submitted change: metadata + changed files with resolved
   * local paths (via `p4 where`). Returns null when the change can't be described.
   * The describe half is immutable (submitted changes never change) and cached as
   * such; local paths come from the separately-cached (ttl) `where` mapping.
   */
  async getGraphChangeDetails(
    id: string,
  ): Promise<(GraphDescribe & { localPaths: Map<string, string> }) | null> {
    const json = await this._cache.wrap(P4CacheNs.describe, id, async () => {
      const res = await this._p4.execRecords(['describe', '-s', id])
      if (res.result.exitCode !== 0) return undefined
      const record = res.records[0]
      if (!record) return undefined
      const parsed = parseChangeDescribe(record)
      return parsed ? JSON.stringify(parsed) : undefined
    })
    if (json === undefined) return null
    const detail = JSON.parse(json) as GraphDescribe
    const localPaths = await this._whereLocalPaths(detail.files.map((f) => f.depotFile))
    return { ...detail, localPaths }
  }

  /** Resolve depot → local paths for a batch of files (`p4 where`). Cached (ttl)
   *  keyed on the sorted depot-file set so repeated lookups reuse one query. */
  private async _whereLocalPaths(depotFiles: readonly string[]): Promise<Map<string, string>> {
    if (depotFiles.length === 0) return new Map()
    const key = [...depotFiles].sort().join('\n')
    const json = await this._cache.wrap(P4CacheNs.where, key, async () => {
      const res = await this._p4.execRecords(['where', ...depotFiles])
      if (res.result.exitCode !== 0) return undefined
      return JSON.stringify([...parseWhereLocalPaths(res.records)])
    })
    return json === undefined ? new Map() : new Map(JSON.parse(json) as [string, string][])
  }

  /**
   * Print a file revision's content (`p4 print -q <spec>`) for the diff editor,
   * or empty string when the spec is null (an added/deleted side) or print fails.
   * A concrete revision's content is immutable, so it's cached (and persisted)
   * under the `print` namespace.
   */
  async printRevision(spec: string | null): Promise<string> {
    if (!spec) return ''
    const value = await this._cache.wrap(P4CacheNs.print, spec, async () => {
      const res = await this._p4.exec(['print', '-q', spec])
      return res.exitCode === 0 ? res.stdout : undefined
    })
    return value ?? ''
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
    this._sc.dispose()
    this._changeListeners.clear()
  }
}
