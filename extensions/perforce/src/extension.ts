/**
 * Perforce extension entry. Discovers the Perforce client (workspace) for the
 * open folder, surfaces it through the SCM API (default + numbered changelist
 * groups driven by `p4 opened` / `p4 changes`), and wires the read-only Phase-1
 * commands (refresh / login / logout / show output / open change). Mutating
 * operations arrive in later phases.
 *
 * `activate` runs inside the extension host process; as a first-party (trusted)
 * extension it may spawn the `p4` CLI directly, exactly like the git extension
 * spawns `git`. Everything is registered on `context.subscriptions`.
 */
import {
  commands,
  workspace,
  window,
  ProgressLocation,
  type ExtensionContext,
  type QuickPickItem,
} from '@universe-editor/extension-api'
import type {
  P4GraphChangeDto,
  P4GraphLoadOptions,
  P4GraphLoadResult,
  P4GraphChangeDetailsDto,
  P4GraphFileChangeDto,
  WorkingTreeChangeDto,
} from '@universe-editor/extensions-common'
import { ConcurrencyGate } from './concurrency.js'
import { setP4CommandTimeoutSeconds, type P4Connection } from './p4Service.js'
import {
  PerforceClient,
  type P4CacheOptions,
  type ReconcileStore,
  type ReconcilePersistState,
} from './client.js'
import type { SyncPreviewFile } from './syncParser.js'
import { P4CacheDisk } from './p4CacheDisk.js'
import { ClientManager } from './clientManager.js'
import { P4StatusBarController } from './p4StatusBar.js'
import { AutoEditController } from './autoEdit.js'
import { WorkspaceWatchController } from './workspaceWatcher.js'
import { notifyP4Failure, setP4OutputShower, isMissingCli } from './p4Error.js'
import { changelistIdFromGroupId, RECONCILE_GROUP_ID, type P4Action } from './changelist.js'
import { statusFromAction, displayPath } from './p4GraphParser.js'
import {
  openGraphFileDiff,
  viewCommit as viewChangelist,
  type P4GraphFileDiffRequest,
} from './viewCommit.js'
import { uriToFsPath, norm } from './pathUtil.js'
import { buildScopeFilespec } from './p4Filespec.js'
import { resolveFocusScopeDirs } from './focusScope.js'
import { registerSwarmCommands } from './swarm/swarmCommands.js'
import { createSwarmLogger } from './swarm/swarmLog.js'
import { createPerforceTimelineCommands, PerforceTimelineProvider } from './timelineProvider.js'
import { switchClient, wireSwitchedClient } from './switchClient.js'
import { localize } from './nls.js'

function resourcePath(arg: unknown): string | undefined {
  return (arg as { resourceUri?: string } | undefined)?.resourceUri
}

/** The changelist a group-scoped command targets, from the `scmResourceGroupId`
 *  the host attaches to group actions ('default' or `cl:<n>`). */
function groupChangelistId(arg: unknown): string | undefined {
  const id = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
  return id === undefined ? undefined : changelistIdFromGroupId(id)
}

/** Resolve the file a file-scoped command acts on: the SCM resource's path when
 *  invoked from the SCM view, else the explorer selection, else the active
 *  editor's file (command-palette / editor-title entry points). Explorer passes
 *  `{ resource }` as a `UriComponents` (its `fsPath` getter is lost over RPC), so
 *  reconstruct the path from scheme + path. */
async function resolveTargetPath(arg: unknown): Promise<string | undefined> {
  const fromResource = resourcePath(arg)
  if (fromResource) return fromResource
  const resource = (arg as { resource?: { scheme?: string; path?: string } } | undefined)?.resource
  const fromExplorer = resource ? uriToFsPath(resource) : undefined
  if (fromExplorer) return fromExplorer
  return commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile')
}

/** Pull the file paths out of an SCM multi-selection argument (the second arg the
 *  view passes on inline actions: an array of `{ resourceUri }`). Pure, so the
 *  multi-select fan-out is unit-testable without the command layer. Returns an
 *  empty array when the value isn't a non-empty selection array. */
export function selectionPaths(selection: unknown): string[] {
  if (!Array.isArray(selection)) return []
  return selection.map(resourcePath).filter((p): p is string => !!p)
}

/** Resolve every path a file-scoped command should act on. When the SCM view runs
 *  an inline action on a multi-selection it passes the full selection as the second
 *  argument (each `{ resourceUri }`); otherwise this falls back to the single
 *  clicked/active path via {@link resolveTargetPath}. */
async function resolveTargetPaths(args: readonly unknown[]): Promise<string[]> {
  const fromSelection = selectionPaths(args[1])
  if (fromSelection.length > 0) return fromSelection
  const single = await resolveTargetPath(args[0])
  return single ? [single] : []
}

async function readFallbackConnection(): Promise<P4Connection> {
  const cfg = workspace.getConfiguration('perforce')
  const port = await cfg.get('port', '')
  const user = await cfg.get('user', '')
  const client = await cfg.get('client', '')
  return {
    ...(port ? { port } : {}),
    ...(user ? { user } : {}),
    ...(client ? { client } : {}),
  }
}

/** The filespec a sync should target for an Explorer/SCM argument: a folder
 *  becomes p4's recursive `<dir>/...`, a file is passed through. Same
 *  `isDirectory` flag the Explorer attaches for `perforce.reconcile`. */
function syncTargetOf(arg: unknown, path: string): string {
  const isDirectory = (arg as { isDirectory?: boolean } | undefined)?.isDirectory === true
  return isDirectory ? `${path.replace(/[/\\]+$/, '')}/...` : path
}

/** Last path segment, for a quick-pick label that isn't a wall of directories. */
function displayName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? path
  )
}

/** The remedies a refused get offers, in the order they are presented.
 *
 *  Collecting first is the answer that loses nothing (p4 then schedules a
 *  resolve), so it leads; force-get destroys uncollected work and therefore
 *  comes after seeing the diff. Pure so the combinations stay covered by unit
 *  tests rather than by clicking through four kinds of refusal by hand. */
export type RefusedSyncButton = 'collect' | 'diff' | 'force' | 'resolve'

export function refusedSyncButtons(state: {
  refusedModified: number
  mustResolve: number
  /** False once this run already forced — a second force would refuse the same way. */
  allowForce: boolean
}): RefusedSyncButton[] {
  const out: RefusedSyncButton[] = []
  if (state.refusedModified > 0) {
    out.push('collect', 'diff')
    if (state.allowForce) out.push('force')
  }
  if (state.mustResolve > 0) out.push('resolve')
  return out
}

/** Confirm a `p4 sync -f`. It re-fetches files p4 believes are already current
 *  and overwrites writable local copies, so it can silently discard uncollected
 *  work — it never runs without the user saying so a second time. */
async function confirmForceGet(): Promise<boolean> {
  const BTN_FORCE = localize('perforce.btn.forceSync', 'Force Get')
  const confirm = await window.showWarningMessage(
    localize(
      'perforce.sync.forceConfirm',
      'Force-get overwrites local files even when Perforce thinks they are current. Uncollected changes in them will be lost. This cannot be undone.',
    ),
    BTN_FORCE,
  )
  return confirm === BTN_FORCE
}

/**
 * The four ways P4V lets you name a revision, as a quick-pick. Returns the p4
 * revision suffix to append to each filespec, or undefined when cancelled.
 *
 * `#head` is separate from the plain "latest" command because this one can also
 * force; the other three ask for a value.
 */
async function pickSyncSpec(): Promise<{ spec: string; force: boolean } | undefined> {
  const picks = [
    {
      id: 'head',
      label: localize('perforce.syncPick.head', 'Latest revision'),
      description: '#head',
    },
    {
      id: 'changelist',
      label: localize('perforce.syncPick.changelist', 'As of a changelist…'),
      description: '@12345',
    },
    {
      id: 'date',
      label: localize('perforce.syncPick.date', 'As of a date…'),
      description: '@2026/08/01',
    },
    {
      id: 'rev',
      label: localize('perforce.syncPick.rev', 'A specific revision…'),
      description: '#4',
    },
    {
      id: 'force',
      label: localize('perforce.syncPick.force', 'Force-get latest (overwrite local files)'),
      description: '#head -f',
    },
  ]
  const choice = await window.showQuickPick(picks, {
    placeHolder: localize('perforce.syncPick.placeholder', 'Which revision do you want?'),
  })
  if (!choice) return undefined
  if (choice.id === 'head') return { spec: '#head', force: false }
  if (choice.id === 'force') return { spec: '#head', force: true }

  const prompts: Record<string, { prompt: string; placeHolder: string }> = {
    changelist: {
      prompt: localize('perforce.syncPrompt.changelist', 'Changelist number'),
      placeHolder: '12345',
    },
    date: {
      prompt: localize('perforce.syncPrompt.date', 'Date (yyyy/mm/dd, optionally with time)'),
      placeHolder: '2026/08/01',
    },
    rev: {
      prompt: localize('perforce.syncPrompt.rev', 'Revision number'),
      placeHolder: '4',
    },
  }
  const ask = prompts[choice.id]
  if (!ask) return undefined
  const raw = await window.showInputBox(ask)
  const value = raw?.trim()
  if (!value) return undefined
  // `@` selects "the state as of", `#` selects a numbered revision — a leading
  // sigil the user typed themselves is honoured rather than doubled.
  if (/^[@#]/.test(value)) return { spec: value, force: false }
  return { spec: choice.id === 'rev' ? `#${value}` : `@${value}`, force: false }
}

/**
 * Floor between two progress reports during a sync. p4 emits one stdout line
 * per file, so an unthrottled bridge would push thousands of RPC messages at
 * the renderer for updates no eye can follow.
 */
const PROGRESS_REPORT_INTERVAL_MS = 150

/** `2026/08/31 14:05` from p4's unix-seconds `time`, for a quick-pick line. */
function formatChangeDate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Ask which changelist to sync the whole scope to.
 *
 * Replaces the old "click the behind count, get `#head`" one-shot: on a game
 * project the newest submit is frequently not the one you want to be on, and a
 * scope-wide jump to it is expensive to undo. Latest stays the first entry, so
 * the previous behaviour is still one keystroke away.
 *
 * Returns the p4 revision suffix to sync to, or undefined when the user backed
 * out (or there was nothing to offer).
 */
async function pickBehindChangelist(
  target: PerforceClient,
  log: (msg: string) => void,
): Promise<string | undefined> {
  const res = await target.listBehindChangelists()
  if (!res.ok) {
    await window.showErrorMessage(
      localize(
        'perforce.behindPick.failed',
        'Could not list the changelists this workspace is behind.',
      ),
    )
    return undefined
  }
  const HEAD_ID = '#head'
  const MORE_ID = 'older'
  const picks: (QuickPickItem & { id: string })[] = [
    {
      id: HEAD_ID,
      label: localize('perforce.behindPick.head', 'Latest revision'),
      description: '#head',
      detail: localize(
        'perforce.behindPick.headDetail',
        'Sync the whole scope to the newest submitted revision',
      ),
    },
  ]
  for (const change of res.changes) {
    const bits = [`@${change.id}`, change.author, formatChangeDate(change.date)].filter(Boolean)
    if (change.status === 'partial') {
      bits.push(localize('perforce.behindPick.partial', 'partially synced'))
    }
    picks.push({
      id: `@${change.id}`,
      label: change.message || `@${change.id}`,
      description: bits.join(' · '),
      detail: localize('perforce.behindPick.detail', 'Sync the scope to the state at @{0}', {
        0: change.id,
      }),
    })
  }
  if (res.hasMore || res.changes.length === 0) {
    picks.push({
      id: MORE_ID,
      label: localize('perforce.behindPick.older', 'An older changelist…'),
      description: '@12345',
    })
  }
  // The placeholder carries the honesty: when cstat couldn't classify, these are
  // simply the most recent changelists and calling them "behind" would be a
  // claim we can't back. Same for a classified-but-empty list — the files we're
  // behind on come from changelists older than the window we listed.
  let placeHolder: string
  if (!res.classified) {
    placeHolder = localize(
      'perforce.behindPick.placeholderUnclassified',
      'Could not tell which are already synced — showing the most recent changelists',
    )
  } else if (res.changes.length === 0) {
    log('[perforce] behind-list: every listed changelist is already synced; offering head/manual')
    placeHolder = localize(
      'perforce.behindPick.placeholderNone',
      'No pending changelists in the listed range — pick latest, or enter an older number',
    )
  } else {
    placeHolder = localize(
      'perforce.behindPick.placeholder',
      'Pick the changelist to sync this workspace to',
    )
  }
  const choice = await window.showQuickPick(picks, { placeHolder })
  if (!choice) return undefined
  if (choice.id !== MORE_ID) return choice.id
  const raw = await window.showInputBox({
    prompt: localize('perforce.syncPrompt.changelist', 'Changelist number'),
    placeHolder: '12345',
  })
  const value = raw?.trim()
  if (!value) return undefined
  // A sigil the user typed themselves is honoured rather than doubled — same
  // rule as pickSyncSpec.
  return /^[@#]/.test(value) ? value : `@${value}`
}

/** Build a per-client {@link ReconcileStore} backed by the extension's
 *  `workspaceState` Memento (persisted per workspace by the host). Keyed by the
 *  normalized client root so multiple clients in one workspace don't clobber each
 *  other's reconcile snapshot. */
function createReconcileStore(context: ExtensionContext, root: string): ReconcileStore {
  const key = `perforce.reconcile.${norm(root)}`
  return {
    load(): ReconcilePersistState {
      return context.workspaceState.get<ReconcilePersistState>(key, { files: [], dismissed: [] })
    },
    save(state: ReconcilePersistState): void {
      void context.workspaceState.update(key, state)
    },
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const root = workspace.rootPath
  if (!root) {
    console.info('[perforce] no workspace folder open; perforce source control disabled')
    return
  }

  const cfg = workspace.getConfiguration('perforce')
  if (!(await cfg.get('enabled', true))) {
    console.error('[perforce] disabled via perforce.enabled')
    return
  }

  const out = window.createOutputChannel('Perforce')
  context.subscriptions.push(out)
  const log = (msg: string): void => out.appendLine(msg)
  setP4OutputShower(() => out.show())

  const maxConcurrent = await cfg.get('maxConcurrent', 4)
  const gate = new ConcurrencyGate(maxConcurrent)
  // Bounds "hung forever", not "slow": a p4 stuck on a frozen network drive /
  // half-open gateway TCP holds its gate slot until killed (the poll wedge).
  setP4CommandTimeoutSeconds(await cfg.get('commandTimeout', 600))
  // `maxConcurrent` was read once above; keep the gate's cap in sync so a change
  // applies without a reload (the background reserve is derived from it).
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.maxConcurrent')) return
      void cfg.get('maxConcurrent', 4).then((n) => gate.setMax(n))
    }),
  )
  const fallback = await readFallbackConnection()

  // Result caching (server round-trips are expensive). Immutable data (submitted
  // changes, specific revisions) can persist across sessions under the extension's
  // globalStoragePath; mutable workspace state uses a short TTL + post-mutation
  // invalidation. All knobs live under `perforce.cache.*`.
  const cacheEnabled = await cfg.get('cache.enabled', true)
  const workspaceTtlMs = await cfg.get('cache.workspaceTtl', 4000)
  const diskLimitMb = await cfg.get('cache.diskLimitMb', 50)
  const disk =
    cacheEnabled && context.globalStoragePath
      ? P4CacheDisk.open(context.globalStoragePath, diskLimitMb * 1024 * 1024, Date.now, log)
      : undefined
  const cacheOptions: P4CacheOptions = {
    enabled: cacheEnabled,
    workspaceTtlMs,
    ...(disk ? { disk } : {}),
  }

  // Probe for a p4 CLI + a client for this folder. A missing binary or a folder
  // outside any Perforce workspace disables the provider without crashing.
  let client: PerforceClient | undefined
  try {
    client = await PerforceClient.create(
      root,
      fallback,
      gate,
      cacheOptions,
      log,
      createReconcileStore(context, root),
    )
  } catch (err) {
    if (isMissingCli(err)) {
      console.info('[perforce] p4 CLI not found; perforce source control disabled')
    } else {
      console.error('[perforce] client discovery failed', err)
    }
    return
  }
  if (!client) {
    console.info(`[perforce] no Perforce workspace for ${root}; source control disabled`)
    return
  }

  const mgr = new ClientManager()
  context.subscriptions.push(mgr)
  mgr.add(client)

  // Ignore-rule capability (host addresses this as `<providerId>.checkIgnore`),
  // registered HERE and not with the other runtime commands far below —
  // deliberately, and this ordering is the whole point:
  //
  // `PerforceClient.create` already published the SourceControl, so from that
  // moment the host's `ScmIgnoredResourcesService` routes ignore lookups to
  // `perforce.checkIgnore`. A lookup that lands before the command exists reads
  // `undefined` and the host caches "not ignored" for that whole batch —
  // permanently, since nothing invalidates again until the workspace changes or
  // an ignore-rule file is saved. Registering it with the rest of the commands
  // leaves several `await`s of window for exactly that (the host's batch debounce
  // is only 150ms), so it goes in the first synchronous slot after the manager
  // exists. The other capabilities tolerate the window because their consumers
  // re-query; this one does not.
  context.subscriptions.push(
    commands.registerCommand('perforce.checkIgnore', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0]) ? (args[0] as string[]) : []
      if (paths.length === 0) return []
      // Data query, not command routing: group by the containing client via
      // `resolveContaining` (no active fallback), dropping paths outside every
      // root — mirrors git's `if (!repo) continue`.
      const byClient = new Map<PerforceClient, string[]>()
      for (const p of paths) {
        const owner = mgr.resolveContaining(p)
        if (!owner) continue
        const list = byClient.get(owner)
        if (list) list.push(p)
        else byClient.set(owner, [p])
      }
      const ignored: string[] = []
      for (const [owner, list] of byClient) {
        ignored.push(...(await owner.checkIgnore(list)))
      }
      return ignored
    }),
  )

  // Timeline — per-file revision history (p4 filelog) for the Explorer Timeline
  // view, the Perforce counterpart of the git extension's provider.
  const timelineProvider = new PerforceTimelineProvider(mgr, log)
  context.subscriptions.push(timelineProvider.trackClient(client))
  context.subscriptions.push(workspace.registerTimelineProvider(['file'], timelineProvider))
  context.subscriptions.push(...createPerforceTimelineCommands(mgr, log))

  const statusBar = new P4StatusBarController(mgr)
  context.subscriptions.push(statusBar)
  statusBar.refresh()

  // Reconcile discovery scope: the workspace focus folders when focus is enabled
  // and non-empty, else the opened folder — so a huge depot is never walked as
  // `//...` on every refresh. Recomputed when the focus config changes; SCM
  // operations stay whole-client (only reconcile discovery is narrowed).
  //
  // Applied BEFORE restoreReconcile(): the restored snapshot goes through the
  // same `_setReconcileFiles` funnel, so setting the scope first is what drops
  // entries a since-narrowed focus no longer covers, instead of rendering them
  // until the next refresh.
  const applyReconcileScope = async (target: PerforceClient): Promise<void> => {
    const scopeCfg = workspace.getConfiguration('workspace')
    const enabled = await scopeCfg.get('focusEnabled', false)
    const folders = await scopeCfg.get<Record<string, unknown>>('focusFolders', {})
    const dirs = resolveFocusScopeDirs({ enabled, folders }, root)
    target.setReconcileScope(dirs.length > 0 ? dirs : root)
    // A scope-less "get latest" follows the same folders: pulling the whole
    // client mapping when the user only opened one subtree is both slow and
    // surprising. Per-file/folder gets pass their own scope and ignore this.
    target.setSyncScope(dirs.length > 0 ? dirs : root)
    log(`[perforce] reconcile scope: ${dirs.length > 0 ? dirs.join(', ') : '<opened folder>'}`)
  }
  const applyReconcileScopeAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyReconcileScope(c)
  }
  await applyReconcileScope(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('workspace.focusEnabled') &&
        !e.affectsConfiguration('workspace.focusFolders')
      ) {
        return
      }
      void applyReconcileScopeAll()
    }),
  )

  /**
   * Behind awareness: how often the client may ask the server "what am I missing".
   * `sync -n` over a game workspace is the most expensive read here, so the
   * interval is a real floor, not a hint — the client clamps anything under 30s.
   *
   * Applied **before** the first refresh: the refresh tail schedules a behind-check
   * that reads these options, so configuring them afterwards would let the very
   * first check silently skip on a workspace the user has auto-check enabled for.
   */
  const applySyncPreviewOptions = async (target: PerforceClient): Promise<void> => {
    const autoCheck = await cfg.get('syncPreview.autoCheck', true)
    const intervalSec = await cfg.get('syncPreview.intervalSec', 300)
    target.setSyncPreviewOptions({ autoCheck, intervalMs: intervalSec * 1000 })
  }
  const applySyncPreviewOptionsAll = async (): Promise<void> => {
    for (const c of mgr.all) await applySyncPreviewOptions(c)
  }
  await applySyncPreviewOptions(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.syncPreview')) return
      void applySyncPreviewOptionsAll()
    }),
  )

  /**
   * Opened-by-others awareness: how often the client may ask "who has what
   * open". Unlike the behind-check this reads the server's open table rather
   * than walking the client view, but it is still a scope-wide background scan,
   * so the interval is a real floor too.
   *
   * Applied **before** the first refresh: the refresh tail schedules the scan
   * and reads these options, so configuring them afterwards would let the very
   * first scan silently skip on a workspace the user has auto-check enabled for.
   */
  const applyOpenedByOthersOptions = async (target: PerforceClient): Promise<void> => {
    const autoCheck = await cfg.get('openedByOthers.autoCheck', true)
    const intervalSec = await cfg.get('openedByOthers.intervalSec', 300)
    target.setOpenedByOthersOptions({ autoCheck, intervalMs: intervalSec * 1000 })
  }
  const applyOpenedByOthersOptionsAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyOpenedByOthersOptions(c)
  }
  await applyOpenedByOthersOptions(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.openedByOthers')) return
      void applyOpenedByOthersOptionsAll()
    }),
  )

  // Restore the persisted "changes to reconcile" snapshot (+ dismissed set) so it
  // shows immediately on reload. This turns reconcile discovery on (sticky) but
  // does NOT trigger a full `reconcile -n` walk — the first refresh below just
  // re-filters the restored list against fresh `opened`, keeping startup cheap on
  // large depots. Use Clean Refresh for an authoritative rescan.
  client.restoreReconcile()
  void client.refresh()

  // Low-frequency background polling (opt-in; server has no FS watcher).
  const refreshInterval = await cfg.get('refreshInterval', 0)
  client.startPolling(refreshInterval)

  // Reconcile discovery: when on, every refresh also scans the working tree for
  // uncollected drift (edited / created / deleted on disk but not opened). Off by
  // default — the scan is heavy on large workspaces; use Clean Refresh / Collect
  // to enable it on demand.
  if (await cfg.get('autoReconcile', false)) client.setAutoReconcile(true)

  // Auto-checkout on edit (opt-in). Disabled config → no subscription.
  const autoEdit = new AutoEditController(mgr, log)
  context.subscriptions.push(autoEdit)
  void autoEdit.start(cfg)

  // Watch the opened workspace folder on disk (default on). A save from the
  // editor or an edit from an external tool schedules a reconcile-discovery
  // refresh, so drifted files surface in "changes to reconcile" without a manual
  // Clean Refresh. We watch the opened folder (not the far larger p4 client root)
  // — see WorkspaceWatchController.
  const watcher = new WorkspaceWatchController(mgr, log)
  context.subscriptions.push(watcher)
  watcher.start(await cfg.get('autoRefresh', true), root)

  /**
   * Open the local-vs-have diff for a file a get refused, so the user can see
   * the uncollected work before deciding whether to collect it or discard it.
   * With several refusals, pick one first — a burst of diff tabs helps nobody.
   *
   * The diff goes straight to the client that ran the get. Routing back through
   * `perforce.openChange` would re-resolve the client from the path, and that
   * lookup falls back to the active repository when no root matches — command
   * semantics, wrong for a file we already know the owner of.
   */
  const openRefusedDiff = async (
    target: PerforceClient,
    refused: readonly SyncPreviewFile[],
  ): Promise<void> => {
    // A file outside the client view has no local path, so there is nothing to
    // diff against. Practically unreachable (p4 only refuses files it mapped), but
    // a button that silently does nothing reads as a broken editor — say so.
    const withLocal = refused.filter(
      (f): f is SyncPreviewFile & { clientFile: string } =>
        f.clientFile !== undefined && f.clientFile !== '',
    )
    const first = withLocal[0]
    if (!first) {
      log(`[perforce] view diff: none of the ${refused.length} refused file(s) have a local path`)
      await window.showWarningMessage(
        localize(
          'perforce.sync.refusedNoLocalPath',
          'Cannot show the differences: the skipped file(s) are not mapped into this workspace.',
        ),
      )
      return
    }
    if (withLocal.length === 1) {
      log(`[perforce] view diff: opening the single refused file ${first.clientFile}`)
      await target.openChange(first.clientFile, false, false)
      return
    }
    const choice = await window.showQuickPick(
      withLocal.map((f) => ({
        id: f.depotFile,
        label: displayName(f.clientFile ?? f.depotFile),
        description: `#${f.rev}`,
        detail: f.depotFile,
      })),
      {
        placeHolder: localize(
          'perforce.sync.refusedPickDiff',
          'Pick a file to see its uncollected local changes',
        ),
      },
    )
    if (!choice) return
    const local = withLocal.find((f) => f.depotFile === choice.id)?.clientFile
    if (local) {
      log(`[perforce] view diff: opening the picked refused file ${local}`)
      await target.openChange(local, false, false)
    }
  }

  /**
   * Run a sync and report the outcome.
   *
   * The watcher is paused for the duration: a sync writes every file it brings
   * in, and letting those writes flow into incremental reconcile would turn a
   * ten-thousand-file get into ten thousand queued `reconcile -n` paths — the
   * user's experience being "it finished, then hung". `client.sync` refreshes
   * afterwards regardless of outcome, so nothing is lost by dropping them.
   *
   * The whole run sits inside a cancellable notification progress. `resolveTotal`
   * (when given) supplies the bar's denominator before p4 starts writing — a
   * scope-wide get is minutes of silence otherwise. Without a denominator the
   * bar stays indeterminate and only the running file count moves: an invented
   * total that finishes at 40% is worse than no total at all.
   */
  const runSync = async (
    target: PerforceClient,
    spec: string,
    options: {
      scope?: readonly string[]
      force?: boolean
      resolveTotal?: () => Promise<number | undefined>
    },
  ): Promise<void> => {
    watcher.pause()
    let res: Awaited<ReturnType<PerforceClient['sync']>>
    try {
      res = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title:
            spec === '#head'
              ? localize('perforce.sync.progressTitleHead', 'Getting the latest revision')
              : localize('perforce.sync.progressTitle', 'Getting {0}', { 0: spec }),
          cancellable: true,
        },
        async (progress, token) => {
          // The status-bar spinner already owns cancellation for p4 operations;
          // routing the notification's button through the same path keeps one
          // abort mechanism instead of two that can disagree.
          const cancelSub = token.onCancellationRequested(() => target.cancelBusy())
          try {
            let total: number | undefined
            if (options.resolveTotal) {
              progress.report({
                message: localize('perforce.sync.progressChecking', 'Checking what to update…'),
              })
              total = await options.resolveTotal()
              if (token.isCancellationRequested) {
                return {
                  ok: false,
                  cancelled: true,
                  summary: undefined,
                  refusedFiles: [],
                  error: undefined,
                }
              }
            }
            // p4 prints one line per file; on a ten-thousand-file get, reporting
            // each one is ten thousand RPC hops for pixels that can't move that
            // fast. Coalesce to ~7fps and settle up at the end.
            let reported = 0
            let reportedAt = 0
            const report = (done: number, file: string | undefined, force: boolean): void => {
              const now = Date.now()
              if (!force && now - reportedAt < PROGRESS_REPORT_INTERVAL_MS) return
              reportedAt = now
              // The denominator is a dry-run estimate of the files this get will
              // touch or refuse; the numerator also counts the "opened and not
              // being changed" lines the estimate leaves out. So `done` can
              // overtake `total` — once it does the denominator is provably wrong
              // and gets dropped rather than clamped, because "8 / 8" while files
              // are still arriving reads as finished when it isn't.
              const denominator =
                total !== undefined && total > 0 && done <= total ? total : undefined
              const message =
                denominator !== undefined
                  ? localize('perforce.sync.progressCount', '{0} / {1}{2}', {
                      0: String(done),
                      1: String(denominator),
                      2: file ? ` · ${file}` : '',
                    })
                  : localize('perforce.sync.progressFiles', '{0} file(s){1}', {
                      0: String(done),
                      1: file ? ` · ${file}` : '',
                    })
              // No usable denominator → message only, which the host renders as an
              // indeterminate bar.
              if (denominator !== undefined) {
                const increment = ((done - reported) / denominator) * 100
                reported = done
                progress.report({ message, increment })
              } else {
                progress.report({ message })
              }
            }
            let lastDone = 0
            const run = await target.sync(spec, {
              ...(options.scope !== undefined ? { scope: options.scope } : {}),
              ...(options.force !== undefined ? { force: options.force } : {}),
              onProgress: ({ done, file }) => {
                lastDone = done
                report(done, file, false)
              },
            })
            if (lastDone > reported) report(lastDone, undefined, true)
            return run
          } finally {
            cancelSub.dispose()
          }
        },
      )
    } finally {
      watcher.resume()
    }
    if (res.cancelled) return
    // Collect exactly what this get was refused on. Falling back to a clean
    // refresh would only *discover* the drift and leave the files still
    // uncollected — a button labelled "Collect Changes" that collects nothing is
    // how a user concludes the get is simply broken. A scope-less get (the
    // status-bar entry, the most common one) is refused over its own default
    // range, so collect that range rather than degrading the far more frequent
    // path to discovery-only.
    const collectScope = async (): Promise<void> => {
      const scope = options.scope
      const targets = scope !== undefined && scope.length > 0 ? scope : target.syncScopes
      await target.reconcile(targets)
    }
    if (!res.ok) {
      const suggestion = res.error?.suggestion
      const message = localize('perforce.sync.failed', 'Get revision failed. {0}', {
        0: suggestion ?? '',
      }).trim()
      // A clobber refusal is the one failure with an obvious next step: the local
      // file has work in it that nobody has collected yet.
      if (res.error?.kind === 'clobber') {
        const BTN_COLLECT = localize('perforce.btn.collectChanges', 'Collect Changes')
        const BTN_FORCE = localize('perforce.btn.forceSync', 'Force Get')
        // No "View Diff" here: a clobber comes back on stderr with exit 1, so the
        // run was interrupted and `refusedFiles` (parsed from stdout) is empty —
        // there is no per-file local path to diff. Force is offered second and
        // still behind its own confirmation: it is the only way out for a user
        // who knows the local copy is disposable, but it destroys that copy.
        const picked = options.force
          ? await window.showErrorMessage(message, BTN_COLLECT)
          : await window.showErrorMessage(message, BTN_COLLECT, BTN_FORCE)
        if (picked === BTN_COLLECT) await collectScope()
        else if (picked === BTN_FORCE && (await confirmForceGet())) {
          await runSync(target, spec, { ...options, force: true })
        }
        return
      }
      await window.showErrorMessage(message)
      return
    }
    const summary = res.summary
    // "Nothing happened" has to account for refusals too, or a run that only
    // refused files reads as an unparseable no-op.
    const nothingHappened =
      !summary ||
      (summary.applied === 0 &&
        summary.keptOpen === 0 &&
        summary.mustResolve === 0 &&
        summary.refusedModified === 0)
    if (summary?.upToDate && nothingHappened) {
      await window.showInformationMessage(
        localize('perforce.sync.upToDate', 'Already at the latest revision.'),
      )
      return
    }
    if (nothingHappened) {
      // Exit 0, nothing applied, and p4 never said "up-to-date" — we genuinely
      // don't know what happened. Claiming the file is current (what this branch
      // used to do) is the worst possible answer: it is indistinguishable from
      // success and sends the user away believing a stale file is fresh. Point at
      // the output channel, where `sync()` logged the raw text.
      const BTN_OUTPUT = localize('perforce.btn.openOutput', 'Open Perforce Output')
      const picked = await window.showWarningMessage(
        localize(
          'perforce.sync.unrecognized',
          'Get revision returned no recognized result. Check the Perforce output for details.',
        ),
        BTN_OUTPUT,
      )
      if (picked === BTN_OUTPUT) out.show()
      return
    }
    // One get can refuse some files and update others: an `allwrite noclobber`
    // client refuses locally-modified files one by one and still exits 0
    // (measured on P4D 2024.2), walking on past them. So every count gets
    // reported — leading with the refusal, which is the outcome with uncollected
    // work at stake, but never at the price of hiding what did land.
    const parts: string[] = []
    if (summary.refusedModified > 0) {
      parts.push(
        localize(
          'perforce.sync.refusedModified',
          '{0} file(s) not updated — they have local changes that have not been collected',
          { 0: String(summary.refusedModified) },
        ),
      )
    }
    // "Updated 0 file(s)" is worth saying on its own, but next to a refusal it is
    // noise — there the refusal already is the story.
    if (summary.applied > 0 || summary.refusedModified === 0) {
      parts.push(
        localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: String(summary.applied) }),
      )
    }
    if (summary.keptOpen > 0) {
      parts.push(
        localize('perforce.sync.keptOpen', '{0} skipped (open for edit)', {
          0: String(summary.keptOpen),
        }),
      )
    }
    if (summary.mustResolve > 0) {
      parts.push(
        localize('perforce.sync.mustResolve', '{0} need merging', {
          0: String(summary.mustResolve),
        }),
      )
    }
    const message = parts.join(' · ')
    // Collecting first is the lossless way out — p4 then schedules a resolve and
    // neither side is dropped — so it leads. Force-get is offered too (some local
    // copies really are disposable), but it destroys uncollected work, so it sits
    // behind the diff and behind its own confirmation.
    const LABELS: Record<RefusedSyncButton, string> = {
      collect: localize('perforce.btn.collectChanges', 'Collect Changes'),
      diff: localize('perforce.btn.viewRefusedDiff', 'View Diff'),
      force: localize('perforce.btn.forceSync', 'Force Get'),
      resolve: localize('perforce.btn.resolveNow', 'Resolve Conflicts'),
    }
    const kinds = refusedSyncButtons({
      refusedModified: summary.refusedModified,
      mustResolve: summary.mustResolve,
      allowForce: options.force !== true,
    })
    if (kinds.length === 0) {
      await window.showInformationMessage(message)
      return
    }
    const picked = await window.showWarningMessage(message, ...kinds.map((k) => LABELS[k]))
    const kind = kinds.find((k) => LABELS[k] === picked)
    if (kind === 'collect') await collectScope()
    else if (kind === 'diff') await openRefusedDiff(target, res.refusedFiles)
    else if (kind === 'force') {
      if (await confirmForceGet()) await runSync(target, spec, { ...options, force: true })
    } else if (kind === 'resolve') {
      await commands.executeCommand('perforce.resolveChangelist', { rootUri: target.root })
    }
  }

  // Swarm (P4 Code Review) commands. Registered unconditionally — the handlers
  // themselves read `perforce.swarm.enabled` / `.url` at call time and no-op with
  // a friendly toast when unconfigured, so toggling config takes effect without a
  // reload. All handlers live in the extension host (safe to declare in commands).
  // Its own output channel + structured logger so Swarm REST / poll logs are
  // timestamped, levelled, and don't mingle with p4 CLI logs. Verbose request
  // tracing is gated behind `perforce.swarm.trace`.
  const swarmOut = window.createOutputChannel('Swarm')
  context.subscriptions.push(swarmOut)
  const swarmLogger = createSwarmLogger((line) => swarmOut.appendLine(line))
  context.subscriptions.push(registerSwarmCommands(mgr, swarmLogger, cacheEnabled))

  // When Swarm is enabled + configured, the commit bar defaults to "Request New
  // Swarm Review…" (P4V parity). Read the same config the swarm handlers use.
  const swarmEnabled = await cfg.get('swarm.enabled', true)
  const swarmUrl = ((await cfg.get('swarm.url', '')) as string).trim()
  client.setSwarmAvailable(Boolean(swarmEnabled) && swarmUrl.length > 0)
  void client.refresh()

  /**
   * Wire a freshly created client in (the switch-workspace quick-pick), applying
   * the same sequence `activate` used for the first client — see
   * {@link wireSwitchedClient} for why the order matters.
   */
  const wireClient = async (newClient: PerforceClient): Promise<void> => {
    const refreshInterval = await cfg.get('refreshInterval', 0)
    const autoReconcile = await cfg.get('autoReconcile', false)
    const swarmOn = await cfg.get('swarm.enabled', true)
    const swarmUrlOn = ((await cfg.get('swarm.url', '')) as string).trim()
    await wireSwitchedClient(
      newClient,
      {
        refreshIntervalSec: refreshInterval,
        autoReconcile,
        swarmAvailable: Boolean(swarmOn) && swarmUrlOn.length > 0,
      },
      {
        add: (c) => mgr.add(c),
        setActive: (r) => mgr.setActive(r),
        statusBarRefresh: () => statusBar.refresh(),
        trackClient: (c) => {
          context.subscriptions.push(timelineProvider.trackClient(c))
        },
        applyScopes: applyReconcileScope,
        applySyncPreviewOptions,
        applyOpenedByOthersOptions,
        startPolling: (c, seconds) => c.startPolling(seconds),
        setAutoReconcile: (c, enabled) => c.setAutoReconcile(enabled),
        setSwarmAvailable: (c, available) => c.setSwarmAvailable(available),
      },
    )
  }

  context.subscriptions.push(
    // Point argument-less commands at the SCM-selected client. Pushed by the
    // renderer's ActiveRepoSyncContribution as `<providerId>.setActiveRepo`.
    commands.registerCommand('perforce.setActiveRepo', (...args: unknown[]) => {
      mgr.setActive(args[0] as string | undefined)
      statusBar.refresh()
    }),

    // Switch the active workspace (client): list the user's clients, pick one,
    // and wire the freshly created client in. The old client stays registered
    // (multiple providers coexist); `mgr.add` dedupes by root.
    commands.registerCommand('perforce.switchClient', () => {
      const current = mgr.active
      if (!current) return
      return switchClient({
        mgr,
        log,
        createClient: (entry) =>
          PerforceClient.createForClient(
            {
              clientName: entry.clientName,
              clientRoot: entry.clientRoot,
              ...(current.user !== undefined ? { userName: current.user } : {}),
            },
            fallback,
            gate,
            cacheOptions,
            log,
            createReconcileStore(context, entry.clientRoot),
          ),
        wire: wireClient,
      })
    }),

    commands.registerCommand('perforce.refresh', (arg) => mgr.resolveClient(arg)?.refresh()),
    // Clean refresh additionally runs the `reconcile -n` discovery pass so the
    // "changes to reconcile" group reflects working-tree drift (files edited /
    // created / deleted on disk but not opened yet).
    commands.registerCommand('perforce.cleanRefresh', (arg) =>
      mgr.resolveClient(arg)?.refresh({ reconcile: true }),
    ),

    // Collect (reconcile) a file's working-tree change into open state. From an
    // SCM "changes to reconcile" row: `{ resourceUri }`; from explorer/editor:
    // the active file. A directory target (explorer right-click on a folder)
    // recurses via p4's `<dir>/...` syntax so the whole subtree is collected.
    // Enables discovery so the group keeps tracking drift.
    commands.registerCommand('perforce.reconcile', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const isDirectory = (args[0] as { isDirectory?: boolean } | undefined)?.isDirectory === true
      const target = isDirectory ? `${path.replace(/[/\\]+$/, '')}/...` : path
      await mgr.resolveClient({ resourceUri: path })?.reconcile([target])
    }),

    // Collect every discovered reconcile candidate at once (group title action).
    commands.registerCommand('perforce.reconcileAll', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.reconcileAll()
    }),

    // --- Sync (get revision) ------------------------------------------------

    // Get the latest revision, no prompt. From the Explorer / editor this targets
    // the clicked file or folder; with no argument it targets the active editor's
    // file — the revision chip in the status bar is per-file, and that is the file
    // it describes. For the whole configured sync scope, see perforce.syncScope.
    commands.registerCommand('perforce.syncLatest', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const scope = path ? [syncTargetOf(args[0], path)] : undefined
      await runSync(target, '#head', scope !== undefined ? { scope } : {})
    }),

    // The "N files behind" status-bar item's click target. Registered at runtime
    // only — it has no menu or command-palette entry; the whole scope is what the
    // count describes, so this is the one sync entry point that must never fall
    // back to the active editor's file (StatusBarItem carries only a command
    // string, with no arguments to distinguish the two intents).
    //
    // It asks which changelist to land on rather than jumping straight to
    // `#head`: the newest submit is not reliably the stable one, and a
    // scope-wide get is expensive to walk back. "Latest revision" is still the
    // first entry of the pick.
    commands.registerCommand('perforce.syncScope', async (arg: unknown) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const spec = await pickBehindChangelist(target, log)
      if (spec === undefined) return
      await runSync(target, spec, {
        resolveTotal: async () => {
          // Head is free: the behind-check already counted exactly this. Any
          // other revision needs its own dry run, and a slow or failed probe
          // just means an indeterminate bar — never a blocked sync.
          if (spec === '#head') return target.status.syncBehindCount
          return target.previewSyncTotal(spec)
        },
      })
    }),

    // Get a specific revision: four ways to name one, matching what P4V offers.
    commands.registerCommand('perforce.sync', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const scope = path ? [syncTargetOf(args[0], path)] : undefined
      const spec = await pickSyncSpec()
      if (spec === undefined) return
      if (spec.force && !(await confirmForceGet())) return
      await runSync(target, spec.spec, {
        ...(scope !== undefined ? { scope } : {}),
        ...(spec.force ? { force: true } : {}),
      })
    }),

    // Dry-run: what would a get bring in. Read-only, so no confirmation.
    commands.registerCommand('perforce.previewSync', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const scope = path ? [syncTargetOf(args[0], path)] : undefined
      const res = await target.previewSync(scope)
      if (!res.ok) {
        await window.showErrorMessage(
          localize('perforce.previewSync.failed', 'Could not preview what would be fetched.'),
        )
        return
      }
      if (res.upToDate) {
        await window.showInformationMessage(
          localize('perforce.sync.upToDate', 'Already at the latest revision.'),
        )
        return
      }
      const picks = res.files.map((f) => ({
        id: f.depotFile,
        label: displayName(f.clientFile ?? f.depotFile),
        description: `${f.action}${f.rev ? ` #${f.rev}` : ''}`,
        detail: f.depotFile,
      }))
      const choice = await window.showQuickPick(picks, {
        placeHolder: localize(
          'perforce.previewSync.placeholder',
          '{0} file(s) would be fetched — pick one to open it',
          { 0: String(res.files.length) },
        ),
      })
      if (!choice) return
      const local = res.files.find((f) => f.depotFile === choice.id)?.clientFile
      if (local) await commands.executeCommand('_workbench.openFile', local)
    }),

    // Copy a file's depot path — the identifier every P4V dialog and Swarm URL
    // wants, and there is no other way to get at it from the editor.
    commands.registerCommand('perforce.copyDepotPath', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const target = mgr.resolveClient({ resourceUri: path })
      if (!target) return
      const info = await target.fstat(path)
      if (!info) {
        await window.showWarningMessage(
          localize('perforce.copyDepotPath.notControlled', 'This file is not in the depot.'),
        )
        return
      }
      await commands.executeCommand('_workbench.writeClipboard', info.depotFile)
    }),

    commands.registerCommand('perforce.showOutput', () => out.show()),

    // Cancel whatever cancellable p4 operation is in flight. Wired to the
    // status-bar spinner's click while it's busy, so a slow operation doesn't have
    // to be waited out. Runtime-only registration (deliberately NOT in
    // `contributes.commands`) — declaring it there registers a handler-less
    // duplicate that shadows this one.
    commands.registerCommand('perforce.cancelBusy', (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      target?.cancelBusy()
    }),

    commands.registerCommand('perforce.login', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const password = await window.showInputBox({
        prompt: localize('perforce.login.prompt', 'Perforce password / ticket'),
      })
      if (password === undefined) return
      const res = await target.login(password)
      if (!res.ok) await notifyP4Failure('login', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.logout', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const res = await target.logout()
      if (!res.ok) await notifyP4Failure('logout', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.openFile', async (...args: unknown[]) => {
      const path =
        resourcePath(args[0]) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (path) await commands.executeCommand('_workbench.openFile', path)
    }),

    commands.registerCommand('perforce.openChange', async (...args: unknown[]) => {
      const [arg, options] = args as [
        unknown,
        ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
      ]
      // From an SCM row: `{ resourceUri }`. From the dirty-diff host / editor
      // title: a bare path string.
      const path = resourcePath(arg) ?? (typeof arg === 'string' ? arg : undefined)
      // Invoked without a resource (keybinding / toolbar): fall back to the
      // renderer so unsaved editor-buffer changes are included in the diff
      // (mirrors git.openChange).
      if (!path) {
        return commands.executeCommand('workbench.action.editor.openActiveFileChanges')
      }
      // Double-click on an SCM row asks to pin (promote out of the preview slot);
      // Space-preview asks to preserve focus. Mirrors git.openChange.
      await mgr
        .resolveClient({ resourceUri: path })
        ?.openChange(path, options?.pinned ?? false, options?.preserveFocus ?? false)
    }),

    // Open a diff for a shelved file (no local copy exists): shelved content vs
    // its base revision. The row carries `{ changelist, depotFile, rev, action }`
    // as the command argument (there's no local path to resolve a client from, so
    // route via the active client).
    commands.registerCommand('perforce.openShelvedFile', async (...args: unknown[]) => {
      const req = args[0] as
        | { changelist?: string; depotFile?: string; rev?: string; action?: string }
        | undefined
      if (!req?.changelist || !req.depotFile) return
      await mgr.active?.openShelvedFile(
        req.changelist,
        req.depotFile,
        req.rev,
        (req.action ?? 'edit') as P4Action,
      )
    }),

    // Dirty-diff baseline: the file's have-revision content (host addresses this
    // as `<providerId>.getHeadContent`). Returns null when there's no baseline.
    commands.registerCommand('perforce.getHeadContent', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getHeadContent(path)) ?? null
    }),

    // Inline blame: annotate the file (host addresses this as
    // `<providerId>.getBlame`). Returns a BlameResultDto, or null on failure.
    commands.registerCommand('perforce.getBlame', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getBlame(path)) ?? null
    }),

    // Explorer working-tree hints: which of these visible rows have local drift
    // that isn't opened yet (host addresses this as `<providerId>.checkWorkingTree`).
    // A batch can span several p4 clients in a multi-root workspace, so paths are
    // grouped by owning client rather than routed off the first one; a path no
    // client owns is simply left out of the answer.
    commands.registerCommand('perforce.checkWorkingTree', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0])
        ? (args[0] as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      if (paths.length === 0) return []
      const enabled = await workspace
        .getConfiguration('perforce')
        .get('reconcileHint.enabled', true)
      if (!enabled) return []

      const byClient = new Map<PerforceClient, string[]>()
      for (const path of paths) {
        // `resolveContaining`, not `resolveClient`: this is a data query, so a
        // path no client owns must be left out of the answer rather than fall
        // back to the active client, which would scan the wrong workspace.
        const client = mgr.resolveContaining(path)
        if (!client) continue
        const list = byClient.get(client)
        if (list) list.push(path)
        else byClient.set(client, [path])
      }
      if (byClient.size === 0) return []

      // One rejected client must not sink the whole batch — the remaining rows
      // still deserve their hints, and this runs on a render path where throwing
      // would surface as an unhandled rejection in the host.
      const perClient = await Promise.all(
        [...byClient].map(async ([client, owned]): Promise<WorkingTreeChangeDto[]> => {
          try {
            return await client.checkWorkingTree(owned)
          } catch (err) {
            log(`[perforce] checkWorkingTree failed for ${client.root}: ${String(err)}`)
            return []
          }
        }),
      )
      return perClient.flat()
    }),

    // --- Mutating operations (Phase 2) -------------------------------------
    // File-scoped ops resolve the client from the resource path; explorer/editor
    // entry points fall back to the active editor's file.

    commands.registerCommand('perforce.edit', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.edit(paths)
    }),

    commands.registerCommand('perforce.add', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.add(paths)
    }),

    commands.registerCommand('perforce.delete', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_DELETE = localize('perforce.btn.delete', 'Mark for Delete')
      const message =
        paths.length === 1
          ? localize('perforce.delete.confirm', "Open '{0}' for delete?", { 0: paths[0]! })
          : localize('perforce.delete.confirmMany', 'Open {0} files for delete?', {
              0: String(paths.length),
            })
      const confirm = await window.showWarningMessage(message, BTN_DELETE)
      if (confirm !== BTN_DELETE) return
      await target.delete(paths)
    }),

    commands.registerCommand('perforce.revert', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
      const message =
        paths.length === 1
          ? localize('perforce.revert.confirm', "Revert '{0}'? Local changes will be lost.", {
              0: paths[0]!,
            })
          : localize(
              'perforce.revert.confirmMany',
              'Revert {0} files? Local changes will be lost.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_REVERT)
      if (confirm !== BTN_REVERT) return
      await target.revert(paths)
    }),

    commands.registerCommand('perforce.revertUnchanged', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.revertUnchanged(groupChangelistId(arg))
    }),

    // Revert every open file in a changelist (destructive — confirm first).
    commands.registerCommand('perforce.revertChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg) ?? 'default'
      if (!target) return
      const label =
        changelist === 'default'
          ? localize('perforce.group.default', 'Default Changelist')
          : `#${changelist}`
      const BTN_REVERT = localize('perforce.btn.revertAll', 'Revert All')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.revertChangelist.confirm',
          'Revert all files in {0}? Local changes will be lost.',
          {
            0: label,
          },
        ),
        BTN_REVERT,
      )
      if (confirm !== BTN_REVERT) return
      await target.revertChangelist(changelist)
    }),

    // Delete an empty numbered changelist (P4V parity). Blocked when it still has
    // open files; any shelf is removed first inside `deleteChangelist`.
    commands.registerCommand('perforce.deleteChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      if (target.hasOpenFiles(changelist)) {
        await window.showWarningMessage(
          localize(
            'perforce.deleteChangelist.notEmpty',
            'Changelist #{0} still has open files. Move or revert them before deleting it.',
            { 0: changelist },
          ),
        )
        return
      }
      const BTN_DELETE = localize('perforce.btn.deleteChangelist', 'Delete Changelist')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.deleteChangelist.confirm',
          'Delete changelist #{0}? Any shelved files it holds will also be deleted.',
          { 0: changelist },
        ),
        BTN_DELETE,
      )
      if (confirm !== BTN_DELETE) return
      await target.deleteChangelist(changelist)
    }),

    // Move file(s) / folder / whole changelist out of their changelist without
    // touching the working tree (`p4 revert -k`): they leave the changelist and
    // reappear under "Changes to Reconcile". From a group header (moves the whole
    // changelist), a folder subtree, or a file selection.
    commands.registerCommand('perforce.moveToReconcile', async (...args: unknown[]) => {
      const arg = args[0]
      const groupId = groupChangelistId(arg)
      const target =
        mgr.resolveClient(arg) ??
        (resourcePath(arg) ? mgr.resolveClient({ resourceUri: resourcePath(arg)! }) : undefined) ??
        mgr.active
      if (!target) return
      const paths =
        groupId && !resourcePath(arg)
          ? target.pathsInChangelist(groupId)
          : await resolveTargetPaths(args)
      if (paths.length === 0) return
      await target.moveToReconcile(paths)
    }),

    // Discard working-tree changes for not-yet-opened (reconcile) files
    // (`p4 clean`). Destructive — confirm first. A directory target recurses via
    // p4's `<dir>/...` syntax.
    commands.registerCommand('perforce.revertReconcile', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const arg0 = args[0] as { isDirectory?: boolean } | undefined
      const target = mgr.resolveClient({ resourceUri: paths[0]! }) ?? mgr.active
      if (!target) return
      const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
      const message =
        paths.length === 1
          ? localize(
              'perforce.revertReconcile.confirm',
              "Discard working-tree changes for '{0}'? This cannot be undone.",
              { 0: paths[0]! },
            )
          : localize(
              'perforce.revertReconcile.confirmMany',
              'Discard working-tree changes for {0} files? This cannot be undone.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_REVERT)
      if (confirm !== BTN_REVERT) return
      const targets =
        arg0?.isDirectory === true && paths.length === 1
          ? [`${paths[0]!.replace(/[/\\]+$/, '')}/...`]
          : paths
      await target.revertReconcile(targets)
    }),

    // Permanently remove file(s) / a folder subtree / the whole group from the
    // "changes to reconcile" list (dismiss). Non-destructive: the working tree is
    // untouched; the entries are just hidden and won't reappear (even after a
    // Clean Refresh) until collected or dismissals are cleared. From the group
    // header this sweeps every listed reconcile file (root as a directory target).
    commands.registerCommand('perforce.dismissReconcile', async (...args: unknown[]) => {
      const arg = args[0]
      const isGroup = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      const target =
        mgr.resolveClient(arg) ??
        (resourcePath(arg) ? mgr.resolveClient({ resourceUri: resourcePath(arg)! }) : undefined) ??
        mgr.active
      if (!target) return
      // Group header (no concrete resource) → sweep the whole list via the root.
      const paths =
        isGroup && !resourcePath(arg) ? [`${target.root}/...`] : await resolveTargetPaths(args)
      if (paths.length === 0) return
      target.dismissReconcile(paths)
    }),

    // Clear all dismissals (unignore everything) and rescan so still-diverged
    // files that were dismissed reappear in the group.
    commands.registerCommand('perforce.clearDismissed', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.clearDismissed()
    }),

    // Submit the default changelist using the SCM input-box description.
    commands.registerCommand('perforce.submitDefault', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = target.description
      if (!description.trim()) {
        await window.showWarningMessage(
          localize('perforce.submit.noDescription', 'Type a changelist description first.'),
        )
        return
      }
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmDefault',
          'Submit the default changelist to the depot? This cannot be undone.',
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      if (await target.submit('default', description)) target.description = ''
    }),

    // Submit a numbered changelist (from its group action) — spec is already set.
    commands.registerCommand('perforce.submitChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmNumbered',
          'Submit changelist #{0} to the depot? This cannot be undone.',
          { 0: changelist },
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      await target.submit(changelist)
    }),

    // --- Numbered changelist management (Phase 3) --------------------------

    commands.registerCommand('perforce.newChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      await target.newChangelist(description)
    }),

    // Move the clicked resource(s) into a changelist chosen from a quick-pick.
    commands.registerCommand('perforce.reopen', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const picks = await target.changelistPicks()
      const choice = await window.showQuickPick(picks, {
        placeHolder: localize('perforce.reopen.placeholder', 'Move file to changelist'),
      })
      if (!choice) return
      if (choice.id === 'new') {
        const description = await window.showInputBox({
          prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
        })
        if (description === undefined) return
        await target.moveToNewChangelist(description, paths)
        return
      }
      await target.reopen(choice.id, paths)
    }),

    // Drag-and-drop target: move dropped files directly into the group they were
    // dropped on — no quick-pick. Bidirectional between changelists and the
    // "changes to reconcile" group:
    //  - onto a changelist (default / numbered): already-opened files are moved
    //    with `reopen -c`; not-yet-opened reconcile files are collected straight
    //    into it with `reconcile -a -e -d -c`.
    //  - onto the reconcile group: opened files are moved out with `revert -k`
    //    (reconcile rows dropped there are already uncollected — a no-op).
    // Registered at runtime (not in package.json's `commands`) so the SCM host can
    // probe it via CommandsRegistry to decide a group accepts drops, without a menu
    // declaration shadowing this handler. args: (groupArg with scmResourceGroupId,
    // selection).
    commands.registerCommand('perforce.reopenTo', async (...args: unknown[]) => {
      const groupId = (args[0] as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      const paths = selectionPaths(args[1])
      if (groupId === undefined || paths.length === 0) return
      const target = mgr.resolveClient(args[0]) ?? mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return

      // Dropped onto the reconcile group → move the opened ones out (`revert -k`);
      // paths already uncollected are skipped (nothing to move out).
      if (groupId === RECONCILE_GROUP_ID) {
        const opened = paths.filter((p) => target.changelistOf(p) !== undefined)
        if (opened.length > 0) await target.moveToReconcile(opened)
        return
      }

      // Otherwise a changelist target: only the default or a numbered pending
      // changelist is valid. A shelved-files group id also survives
      // `changelistIdFromGroupId` as a bare number, so reject it by raw id first.
      if (groupId.startsWith('shelved:')) return
      const changelist = changelistIdFromGroupId(groupId)
      if (changelist !== 'default' && !/^\d+$/.test(changelist)) return
      // Split by open state: opened files are reopened into the target; not-yet-
      // opened reconcile files are collected straight into it.
      const opened = paths.filter((p) => target.changelistOf(p) !== undefined)
      const uncollected = paths.filter((p) => target.changelistOf(p) === undefined)
      if (uncollected.length > 0) await target.reconcileInto(changelist, uncollected)
      if (opened.length > 0) await target.reopen(changelist, opened)
    }),

    // One-step "group these edits into a new changelist": from a changelist group
    // header (moves the whole group) or a file-row selection (moves those files).
    commands.registerCommand('perforce.moveToNewChangelist', async (...args: unknown[]) => {
      const arg = args[0]
      const groupId = groupChangelistId(arg)
      const target =
        mgr.resolveClient(arg) ??
        (resourcePath(arg) ? mgr.resolveClient({ resourceUri: resourcePath(arg)! }) : undefined) ??
        mgr.active
      if (!target) return
      // Group-header invocation (a group id but no concrete resource) moves every
      // file in that changelist; a file-row invocation moves the selection.
      const paths =
        groupId && !resourcePath(arg)
          ? target.pathsInChangelist(groupId)
          : await resolveTargetPaths(args)
      if (paths.length === 0) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      await target.moveToNewChangelist(description, paths)
    }),

    commands.registerCommand('perforce.editChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const current = await target.getChangelistDescription(changelist)
      const description = await window.showInputBox({
        prompt: localize('perforce.editChangelist.prompt', 'Changelist description'),
        value: current,
      })
      if (description === undefined) return
      await target.editChangelistDescription(changelist, description)
    }),

    // --- Shelve / unshelve (Phase 3) --------------------------------------

    // Shelve a whole changelist. Works from a group header or a file row (both
    // carry `scmResourceGroupId`) — per the design, a file-row shelve archives the
    // file's entire changelist. The default changelist can't be shelved directly
    // (p4 requires a numbered CL), so its files are first moved into a fresh
    // numbered changelist (description prompted), then shelved.
    commands.registerCommand('perforce.shelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist) return
      if (changelist === 'default') {
        const paths = target.pathsInChangelist('default')
        if (paths.length === 0) {
          await window.showWarningMessage(
            localize(
              'perforce.shelve.defaultEmpty',
              'The default changelist has no files to shelve.',
            ),
          )
          return
        }
        const description = await window.showInputBox({
          prompt: localize(
            'perforce.shelve.defaultPrompt',
            'Description for the new changelist to shelve into',
          ),
        })
        if (description === undefined) return
        const created = await target.moveToNewChangelist(description, paths)
        if (!created) return
        await target.shelve(created)
        return
      }
      await target.shelve(changelist)
    }),

    // Unshelve a whole changelist (group header) or a single shelved file (row).
    commands.registerCommand('perforce.unshelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const depotFile = resourcePath(arg)
      if (depotFile) await target.unshelveFile(changelist, depotFile)
      else await target.unshelve(changelist)
    }),

    // Restore an arbitrary shelved changelist by number (command palette) — for a
    // shelf not shown in this workspace's panel. Force-overwrites, so confirm.
    commands.registerCommand('perforce.unshelveByNumber', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const changelist = await window.showInputBox({
        prompt: localize('perforce.unshelveByNumber.prompt', 'Changelist number to unshelve'),
      })
      const id = changelist?.trim()
      if (!id) return
      if (!/^\d+$/.test(id)) {
        await window.showWarningMessage(
          localize('perforce.unshelveByNumber.invalid', 'Enter a numeric changelist id.'),
        )
        return
      }
      const BTN_UNSHELVE = localize('perforce.btn.unshelve', 'Unshelve')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.unshelveByNumber.confirm',
          'Unshelve changelist #{0}? This overwrites local copies of any files it touches.',
          { 0: id },
        ),
        BTN_UNSHELVE,
      )
      if (confirm !== BTN_UNSHELVE) return
      await target.unshelveByNumber(id)
    }),

    // Delete a whole changelist's shelf (group header) or a single shelved file (row).
    commands.registerCommand('perforce.deleteShelved', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const depotFile = resourcePath(arg)
      const BTN_DELETE = localize('perforce.btn.deleteShelved', 'Delete Shelved')
      const message = depotFile
        ? localize('perforce.deleteShelved.confirmFile', "Delete shelved file '{0}'?", {
            0: depotFile,
          })
        : localize('perforce.deleteShelved.confirm', 'Delete shelved files in changelist #{0}?', {
            0: changelist,
          })
      const confirm = await window.showWarningMessage(message, BTN_DELETE)
      if (confirm !== BTN_DELETE) return
      if (depotFile) await target.deleteShelvedFile(changelist, depotFile)
      else await target.deleteShelved(changelist)
    }),

    // --- Resolve (Phase 3) ------------------------------------------------

    commands.registerCommand('perforce.resolve', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.resolve(paths)
    }),

    commands.registerCommand('perforce.resolveChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.resolveChangelist(groupChangelistId(arg) ?? 'default')
    }),

    // Accept our side of the merge for each file (`resolve -ay`): discards the
    // incoming side. Destructive — confirm first, like revert/delete.
    commands.registerCommand('perforce.resolveAcceptYours', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_ACCEPT = localize('perforce.btn.acceptYours', 'Accept Yours')
      const message =
        paths.length === 1
          ? localize(
              'perforce.resolveAcceptYours.confirm',
              "Resolve '{0}' by accepting your version? The incoming changes will be discarded.",
              { 0: paths[0]! },
            )
          : localize(
              'perforce.resolveAcceptYours.confirmMany',
              'Resolve {0} files by accepting your version? The incoming changes will be discarded.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_ACCEPT)
      if (confirm !== BTN_ACCEPT) return
      await target.resolveAcceptYours(paths)
    }),

    // Accept the incoming side of the merge (`resolve -at`): discards our local
    // edits. Destructive — confirm first.
    commands.registerCommand('perforce.resolveAcceptTheirs', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_ACCEPT = localize('perforce.btn.acceptTheirs', 'Accept Theirs')
      const message =
        paths.length === 1
          ? localize(
              'perforce.resolveAcceptTheirs.confirm',
              "Resolve '{0}' by accepting the incoming version? Your local changes will be discarded.",
              { 0: paths[0]! },
            )
          : localize(
              'perforce.resolveAcceptTheirs.confirmMany',
              'Resolve {0} files by accepting the incoming version? Your local changes will be discarded.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_ACCEPT)
      if (confirm !== BTN_ACCEPT) return
      await target.resolveAcceptTheirs(paths)
    }),

    // Open the 3-way merge editor for an unresolved file (base = have revision,
    // incoming = depot head, result seed = the on-disk file with p4 conflict
    // markers). Saving runs `perforce.acceptResolved` (`resolve -ay`).
    commands.registerCommand('perforce.openMergeEditor', async (...args: unknown[]) => {
      const path = resourcePath(args[0]) ?? (typeof args[0] === 'string' ? args[0] : undefined)
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.openMergeEditor(path)
    }),

    // Runtime command — NOT declared in contributes.commands (a declared
    // same-name command without a handler would shadow this one and silently
    // no-op). The merge editor's save follow-up: the user hand-merged on disk,
    // so saving accepts that content as the resolution (`resolve -ay`).
    commands.registerCommand('perforce.acceptResolved', async (...args: unknown[]) => {
      const path = resourcePath(args[0]) ?? (typeof args[0] === 'string' ? args[0] : undefined)
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.acceptResolved(path)
    }),

    // --- Perforce Graph (read-only submitted-change history) ----------------
    // The client the graph targets. Defaults to the active client; `setRepo`
    // switches it to another discovered client (multi-client is a later
    // refinement, but the plumbing mirrors git-graph so it's ready).
    ...(() => {
      let graphRoot: string | undefined

      const graphClient = () =>
        (graphRoot ? mgr.resolveClient({ rootUri: graphRoot }) : undefined) ?? mgr.active

      const DEFAULT_MAX = 300

      // Default graph scope: the opened workspace folder as a p4 filespec
      // (`<path>/...`), so the graph mirrors what the user actually has open
      // rather than the whole client depot. `wholeRepo` widens it to `//...`.
      const workspaceScope = buildScopeFilespec(root, true)

      return [
        commands.registerCommand('perforce-graph.getRepos', () =>
          mgr.all.map((c) => ({ root: c.root, name: c.clientName })),
        ),
        commands.registerCommand('perforce-graph.setRepo', (...args: unknown[]) => {
          const next = args[0] as string
          if (next) graphRoot = next
          return true
        }),
        commands.registerCommand('perforce-graph.getChanges', async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as P4GraphLoadOptions
          const max = opts.maxChanges ?? DEFAULT_MAX

          // Scoped query: resolve the client by strict longest prefix (data-query
          // semantics, no active fallback — mirrors the timeline provider) and build
          // a path filespec. Never touches `graphRoot`, the graph's shared mutable
          // state, so a scoped read can't leak into the whole-graph view.
          let target: PerforceClient | undefined
          let scope: string
          let pendingScope: { path: string; isDirectory: boolean } | undefined
          if (opts.scopePath) {
            target = mgr.resolveContaining(opts.scopePath)
            scope = buildScopeFilespec(opts.scopePath, opts.scopeIsDirectory === true)
            pendingScope = { path: opts.scopePath, isDirectory: opts.scopeIsDirectory === true }
            log(`[perforce] graph scoped to ${scope}`)
          } else {
            target = graphClient()
            scope = opts.wholeRepo ? '//...' : workspaceScope
            pendingScope = undefined
          }
          if (!target) return null

          const [changes, pendingCount] = await Promise.all([
            target.getGraphChanges(max, scope),
            target.getPendingCount(pendingScope),
          ])
          if (!changes) return null
          const moreAvailable = changes.length > max
          const visible = changes.slice(0, max)
          const dtos = visible.map(
            (c, i) =>
              ({
                id: c.id,
                parents: visible[i + 1] ? [visible[i + 1]!.id] : [],
                author: c.author,
                client: c.client,
                date: c.date,
                message: c.message,
                body: c.body,
              }) satisfies P4GraphChangeDto,
          )
          return {
            changes: dtos,
            head: visible[0]?.id ?? null,
            headClient: target.clientName,
            moreAvailable,
            pendingCount,
          } satisfies P4GraphLoadResult
        }),
        commands.registerCommand('perforce-graph.getChangeDetails', async (...args: unknown[]) => {
          const id = args[0] as string
          const target = graphClient()
          if (!target) return null
          const detail = await target.getGraphChangeDetails(id)
          if (!detail) return null
          return {
            id: detail.id,
            author: detail.author,
            client: detail.client,
            date: detail.date,
            body: detail.body,
            files: detail.files.map(
              (f) =>
                ({
                  status: statusFromAction(f.action),
                  path: displayPath(f.depotFile),
                  oldPath: null,
                  depotFile: f.depotFile,
                  rev: f.rev,
                  localPath: detail.localPaths.get(f.depotFile) ?? null,
                }) satisfies P4GraphFileChangeDto,
            ),
          } satisfies P4GraphChangeDetailsDto
        }),
        commands.registerCommand('perforce-graph.getPendingChanges', async () => {
          const target = graphClient()
          if (!target) return []
          const opened = await target.getOpenedForGraph()
          return opened.map((f) => {
            const status = statusFromAction(f.action)
            return {
              status,
              path: displayPath(f.depotFile),
              oldPath: null,
              depotFile: f.depotFile,
              rev: f.rev ?? '',
              localPath: f.localPath,
            } satisfies P4GraphFileChangeDto
          })
        }),
        // Open Commit: the blame/status-bar route. Resolves the uri's client
        // (falling back to the graph's current client) and opens the whole
        // changelist in the commit-changes view.
        commands.registerCommand('perforce.viewCommit', async (...args: unknown[]) => {
          await viewChangelist(mgr, graphClient, args[0], args[1], log)
        }),
        commands.registerCommand('perforce-graph.openFileDiff', async (...args: unknown[]) => {
          const target = graphClient()
          if (!target) return
          await openGraphFileDiff(
            target,
            args[0] as P4GraphFileDiffRequest,
            args[1] as { preserveFocus?: boolean } | undefined,
          )
        }),
        commands.registerCommand(
          'perforce-graph.openWorkingTreeFile',
          async (...args: unknown[]) => {
            const localPath = args[0] as string
            if (!localPath) return
            // Pending files: show the have-revision vs local diff (mirrors the
            // SCM row's Open Changes), falling back to opening the file.
            await mgr.resolveClient({ resourceUri: localPath })?.openChange(localPath)
          },
        ),
      ]
    })(),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (clients, status bar, commands) handle teardown.
}
