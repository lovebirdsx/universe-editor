/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side owner of the Extension Host connection. Runs a single local host
 *  for both built-in and external extensions (a HostConnection over stdio RPC),
 *  following VSCode's model where activation is gated by Workspace Trust rather
 *  than by install source.
 *
 *  Responsibilities beyond wiring (which lives in HostConnection): lazy start,
 *  exposing contributions, routing contributed-command execution to the host, and
 *  lifecycle — crash detection with bounded restart, plus a coordinated restart
 *  when the workspace folder changes (the host pins the folder at launch, so a
 *  swap requires a relaunch).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IAiModelService,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IFileDialogService,
  IFileSearchService,
  IFileService,
  IFileWatcherService,
  IHostService,
  IInstantiationService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOpenerService,
  IOutputService,
  IProgressService,
  IQuickInputService,
  IStatusBarService,
  IStorageService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  IWorkspaceTrustManagementService,
  Severity,
  localize,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import {
  STARTUP_ACTIVATION,
  STARTUP_FINISHED_ACTIVATION,
  type IExtHostDocuments,
  type IExtHostLanguages,
  type IExtensionDescriptionDto,
  type IExtensionActivationErrorDto,
} from '@universe-editor/extensions-common'
import {
  IExtensionHostService,
  type ExtHostExitEvent,
  type ExtHostStartSpec,
} from '../../../shared/ipc/extensionHostService.js'
import { IExtensionManagementService } from '../../../shared/ipc/extensionManagementService.js'
import { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import { IAcpPathPolicy } from '../acp/acpPathPolicy.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IOutOfWorkspaceWatchService } from '../files/outOfWorkspaceWatchService.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'
import { DEEP_LINK_PROTOCOL } from '../../../shared/deepLink.js'
import { IScmService } from './ScmService.js'
import { ITimelineService } from '../timeline/TimelineService.js'
import { ITreeViewsService } from './TreeViewsService.js'
import { IWebviewService } from './WebviewService.js'
import { IExtensionEnablementService } from './ExtensionEnablementService.js'
import { HostConnection, type HostConnectionDeps } from './HostConnection.js'

export interface IExtensionHostClientService {
  readonly _serviceBrand: undefined
  /** Spawn the host and connect its RPC. Idempotent. */
  start(): Promise<void>
  /** All scanned extensions' static contributions, for the translator. */
  getContributions(): Promise<IExtensionDescriptionDto[]>
  /**
   * Fires the merged static contributions whenever the live host set changes —
   * i.e. after the host is relaunched (workspace swap or crash recovery). The
   * translator re-applies them so contributed commands survive a restart that
   * raced the initial boot's one-shot translation.
   */
  readonly onDidChangeContributions: Event<readonly IExtensionDescriptionDto[]>
  /**
   * Fires when an extension's `activate` throws in the host. The host isolates the
   * failure (it never tears down), so this is the only signal the renderer gets to
   * surface a silently non-functional extension.
   */
  readonly onDidActivationError: Event<IExtensionActivationErrorDto>
  /** Activate every extension whose activationEvents match `event`. */
  activateByEvent(event: string): Promise<void>
  /**
   * Re-scan after the installed (external) set changed (install / uninstall).
   * Starts the host if it wasn't running (first-ever install), restarts it if it
   * was, and re-emits contributions so the newly added / removed extensions'
   * commands take effect.
   */
  refreshExtensions(): Promise<void>
  /** Execute a command contributed by an activated extension, via the host. */
  executeContributedCommand(id: string, args: unknown[]): Promise<unknown>
  /** The host's language RPC proxy, once connected. */
  getLanguages(): IExtHostLanguages | undefined
  /** The host's document-mirror RPC proxy, once connected. */
  getDocuments(): IExtHostDocuments | undefined
}

export const IExtensionHostClientService = createDecorator<IExtensionHostClientService>(
  'extensionHostClientService',
)

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BASE_DELAY_MS = 1_000

/**
 * Unique per renderer session, backing `env.sessionId`. Module-level so it stays
 * stable across extension-host restarts within the same editor session.
 */
const EXTENSION_SESSION_ID = crypto.randomUUID()

interface RestartState {
  windowStart: number
  count: number
}

export class ExtensionHostClientService extends Disposable implements IExtensionHostClientService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private _conn: HostConnection | undefined
  private _starting: Promise<void> | undefined
  /**
   * In-flight workspace re-pin. When the workspace folder changes, the host must
   * be relaunched to re-pin `workspace.rootPath` (see {@link _onWorkspaceChanged}).
   * That relaunch is async, so a command racing it — e.g. the markdown
   * update-links-on-rename flush firing on the same `onDidRunFileOperation` burst
   * that just swapped the workspace — could otherwise execute against the host
   * still pinned to the *previous* (often empty) workspace, whose workspace scan
   * returns nothing. `start()` awaits this so every command sees the re-pinned host.
   */
  private _repinning: Promise<void> | undefined

  /** Connections keyed by their live handle, for routing onExit. */
  private readonly _byHandle = new Map<string, HostConnection>()
  /** Contributed-command id → owning connection. */
  private readonly _commandOwner = new Map<string, HostConnection>()
  /** Per-handle static contributions, so a restart can re-emit the merged set. */
  private readonly _contributionsByHandle = new Map<string, readonly IExtensionDescriptionDto[]>()
  private readonly _onDidChangeContributions = this._register(
    new Emitter<readonly IExtensionDescriptionDto[]>(),
  )
  readonly onDidChangeContributions = this._onDidChangeContributions.event
  private readonly _onDidActivationError = this._register(
    new Emitter<IExtensionActivationErrorDto>(),
  )
  readonly onDidActivationError = this._onDidActivationError.event
  /** Handles we asked to stop (planned restarts) — their exit must not trigger crash handling. */
  private readonly _stopping = new Set<string>()
  private readonly _restartState: RestartState = { windowStart: 0, count: 0 }
  /** Signature of the disabled set the host was last launched with, to skip no-op restarts. */
  private _launchedDisabledIds = ''
  /**
   * Serializes host restarts. A workspace swap, the trust flip and the enablement
   * change that accompany it often fire on the same turn; without a queue each
   * enters the restart independently and the later one tears down the connection
   * the earlier one just spawned — rejecting its in-flight `$activateByEvent`
   * with IpcChannelDisposedError, which escaped as an unhandled rejection.
   */
  private _restartQueue: Promise<void> = Promise.resolve()

  constructor(
    @IExtensionHostService private readonly _host: IExtensionHostService,
    @IOutputService private readonly _output: IOutputService,
    @ILoggerService loggerService: ILoggerService,
    @INotificationService private readonly _notification: INotificationService,
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IDialogService private readonly _dialog: IDialogService,
    @IScmService private readonly _scm: IScmService,
    @ITimelineService private readonly _timeline: ITimelineService,
    @ITreeViewsService private readonly _treeViews: ITreeViewsService,
    @IWebviewService private readonly _webview: IWebviewService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _files: IFileService,
    @IAcpPathPolicy private readonly _pathPolicy: IAcpPathPolicy,
    @ICommandService private readonly _commandService: ICommandService,
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
    @IEditorService private readonly _editorService: IEditorService,
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IStorageService private readonly _storage: IStorageService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IExtensionManagementService private readonly _management: IExtensionManagementService,
    @IExtensionEnablementService private readonly _enablement: IExtensionEnablementService,
    @IWorkspaceTrustManagementService
    private readonly _workspaceTrust: IWorkspaceTrustManagementService,
    @IHostService private readonly _hostService: IHostService,
    @IOpenerService private readonly _opener: IOpenerService,
    @IProgressService private readonly _progressService: IProgressService,
    @IFileDialogService private readonly _fileDialogs: IFileDialogService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IFileWatcherService private readonly _fileWatcher: IFileWatcherService,
    @IOutOfWorkspaceWatchService
    private readonly _outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'extHostClient', name: 'Extension Host' })
    this._register(this._host.onExit((evt) => this._onHostExit(evt)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._onWorkspaceChanged()))
    this._register(
      this._enablement.onDidChangeEnablement(() => {
        void this._onEnablementChanged().catch((err: unknown) => {
          this._logger.warn(`enablement change handling failed: ${(err as Error).message}`)
        })
      }),
    )
    this._register(
      this._workspaceTrust.onDidChangeTrust((t) => {
        void this._onTrustChanged(t).catch((err: unknown) => {
          this._logger.warn(`workspace trust change handling failed: ${(err as Error).message}`)
        })
      }),
    )
    // Forward configuration changes to the host (`workspace.onDidChangeConfiguration`).
    // Changes landing while no host is connected are simply lost — the host reads
    // current values through its configuration snapshot on (re)start anyway.
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.keys.length === 0) return
        const conn = this._conn
        if (!conn || conn.dead) return
        void conn.extensions.$acceptConfigurationChanged([...e.keys]).catch((err: unknown) => {
          if (conn.dead) return
          this._logger.warn(`configuration change push failed: ${(err as Error).message}`)
        })
      }),
    )

    // A window reload destroys this renderer without disposing its services, so
    // the async dispose() path never runs on reload. Synchronously stop every
    // live host child here: ProxyChannel dispatches host.stop via
    // ipcRenderer.send before teardown, so main reaps the (heavy — the
    // typescript plugin self-spawns tsserver) processes instead of orphaning a
    // fresh trusted host on every reload. Across the shared-app E2E suite those
    // orphans pile up and starve later spawns (ACP initialize, etc.).
    if (typeof window !== 'undefined') {
      const onBeforeUnload = (): void => {
        for (const handle of this._byHandle.keys()) {
          void this._host.stop(handle).catch(() => {
            // best-effort — the renderer is going away
          })
        }
      }
      window.addEventListener('beforeunload', onBeforeUnload)
      this._register({
        dispose: () => window.removeEventListener('beforeunload', onBeforeUnload),
      })
    }
  }

  start(): Promise<void> {
    if (!this._starting) {
      this._starting = this._connect().catch((err: unknown) => {
        this._starting = undefined
        throw err
      })
    }
    return this._starting
  }

  /**
   * Await the host being ready AND pinned to the current workspace: block on any
   * in-flight workspace re-pin (see {@link _repinning}) before returning the live
   * start. A command must never run against a host still pinned to the previous
   * workspace — its workspace scan would come back empty.
   */
  private async _whenReady(): Promise<void> {
    // Drain the re-pin barrier: a swap arriving while we await one replaces it
    // with a fresh (chained) barrier, so loop until none is outstanding.
    let inflight: Promise<void> | undefined
    while (this._repinning && this._repinning !== inflight) {
      inflight = this._repinning
      await inflight
    }
    await this.start()
  }

  private async _connect(): Promise<void> {
    await this._workspace.whenReady
    const workspaceRoot = this._workspace.current?.folder.fsPath
    // Single local host: filter the scan by the effective disabled set (global +
    // workspace) across both built-in and external extensions.
    const disabledIds = await this._disabledIds()
    this._launchedDisabledIds = disabledSignature(disabledIds)
    // Only scan the user (external) dir when it actually has extensions.
    const includeUser = await this._host.hasUserExtensions()
    const spec: ExtHostStartSpec = {
      locale: getCurrentLocale(),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(includeUser ? {} : { userExtensionsDir: '' }),
      ...(disabledIds.length > 0 ? { disabledIds } : {}),
    }
    const { handle } = await this._host.start(spec)

    const stderr = this._output.createChannel('Extension Host')
    const deps: HostConnectionDeps = {
      host: this._host,
      notification: this._notification,
      quickInput: this._quickInput,
      statusBar: this._statusBar,
      dialog: this._dialog,
      files: this._files,
      fileSearch: this._fileSearch,
      exclude: this._exclude,
      fileWatcher: this._fileWatcher,
      outOfWorkspaceWatch: this._outOfWorkspaceWatch,
      pathPolicy: this._pathPolicy,
      commandService: this._commandService,
      opener: this._opener,
      progress: this._progressService,
      fileDialogs: this._fileDialogs,
      editorGroups: this._editorGroups,
      instantiation: this._instantiation,
      storage: this._storage,
      webview: this._webview,
      scm: this._scm,
      timeline: this._timeline,
      treeViews: this._treeViews,
      languageFeatures: this._languageFeatures,
      editorService: this._editorService,
      uriIdentity: this._uriIdentity,
      aiModel: this._aiModel,
      output: this._output,
      layout: this._layout,
      views: this._views,
      stderr,
      logger: this._logger,
      platform: this._hostService.platform,
      ledger: {
        claim: (id) => this._claimCommand(id),
        release: (id) => this._commandOwner.delete(id),
      },
      onActivationError: (error) => this._onActivationErrorReported(error),
    }

    const connection = this._register(new HostConnection('local', handle, workspaceRoot, deps))
    this._byHandle.set(handle, connection)
    this._conn = connection
    // Seed Workspace Trust before any activation so `workspace.isTrusted` is
    // correct inside extensions' `activate`.
    await this._workspaceTrust.workspaceTrustInitialized
    await connection.extensions.$initializeWorkspaceTrust(this._workspaceTrust.isWorkspaceTrusted())
    // Seed the `env` namespace (product identity, per-session id, deep-link
    // scheme, display language) alongside, so `env.*` reads correctly inside
    // extensions' `activate` too.
    const versionInfo = await this._hostService.getVersionInfo()
    await connection.extensions.$initializeEnvironment({
      appName: versionInfo.productName,
      appVersion: versionInfo.version,
      sessionId: EXTENSION_SESSION_ID,
      uriScheme: DEEP_LINK_PROTOCOL,
      language: getCurrentLocale(),
      machineId: versionInfo.machineId,
      appRoot: versionInfo.appRoot,
    })
    this._logger.info(`extension host connected handle=${handle}`)
  }

  /**
   * Trust flipped. A grant is dynamic — tell the host and re-run activation so
   * newly-eligible extensions start (VSCode's `$onDidGrantWorkspaceTrust`). A
   * revoke can't unload already-activated extensions in place, so it restarts
   * the host, which recomputes the activation gate from scratch.
   */
  private async _onTrustChanged(trusted: boolean): Promise<void> {
    await Promise.allSettled([this._starting])
    if (trusted) {
      const conn = this._conn
      if (!conn || conn.dead) return
      // The host replays every activation event it has seen, so gated-off
      // extensions activate for already-open documents too — no renderer replay.
      try {
        await conn.extensions.$onDidGrantWorkspaceTrust()
      } catch (err) {
        // A queued restart stopped this connection while the grant was in flight.
        if (conn.dead) return
        throw err
      }
      this._logger.info('workspace trust granted; host replayed activation')
    } else {
      this._logger.info('workspace trust revoked; restarting extension host')
      await this._restart('workspace')
    }
  }

  /** The effective disabled ids across all installed extensions. */
  private async _disabledIds(): Promise<string[]> {
    const effective = new Set(await this._enablement.getEffectiveDisabledIds())
    if (effective.size === 0) return []
    const owned = [
      ...(await this._management.listBuiltinExtensions()),
      ...(await this._management.getInstalled()),
    ]
    return owned.map((e) => e.identifier).filter((id) => effective.has(id))
  }

  private _claimCommand(id: string): void {
    if (this._conn) this._commandOwner.set(id, this._conn)
  }

  /**
   * An extension's `activate` threw in the host. Fire the event (Extensions view
   * badges the offending row) and raise a notification so the failure is visible
   * instead of the extension silently having no effect.
   */
  private _onActivationErrorReported(error: IExtensionActivationErrorDto): void {
    this._logger.warn(`extension activation failed ${error.extensionId}: ${error.message}`)
    this._onDidActivationError.fire(error)
    const name = error.displayName ?? error.extensionId
    this._notification.notify({
      severity: Severity.Error,
      message: localize(
        'extensions.activation.failed',
        'Extension "{name}" failed to activate: {error}',
        { name, error: error.message },
      ),
    })
  }

  async getContributions(): Promise<IExtensionDescriptionDto[]> {
    await this.start()
    const lists = await Promise.all(this._liveConnections().map((c) => this._fetchAndIndex(c)))
    return lists.flat()
  }

  /** Fetch a connection's contributions and record which tier owns each command. */
  private async _fetchAndIndex(conn: HostConnection): Promise<IExtensionDescriptionDto[]> {
    const list = await conn.extensions.$getContributions()
    this._contributionsByHandle.set(conn.handle, list)
    for (const ext of list) {
      for (const command of ext.contributes.commands ?? []) {
        this._commandOwner.set(command.command, conn)
      }
    }
    return list
  }

  /** Merged contributions across every live tier, from the per-handle cache. */
  private _mergedContributions(): IExtensionDescriptionDto[] {
    return this._liveConnections().flatMap((c) => [
      ...(this._contributionsByHandle.get(c.handle) ?? []),
    ])
  }

  async activateByEvent(event: string): Promise<void> {
    await this._whenReady()
    await Promise.all(this._liveConnections().map((c) => c.extensions.$activateByEvent(event)))
  }

  async refreshExtensions(): Promise<void> {
    // The installed (external) set changed. Restart the single host so it
    // re-scans both dirs and re-emits contributions. `_restart` handles the
    // not-yet-started case (skips the stop when there's no connection).
    if (!this._conn) {
      this._starting = undefined
    }
    await this._restart('workspace')
  }

  async executeContributedCommand(id: string, args: unknown[]): Promise<unknown> {
    await this._whenReady()
    const conn = this._commandOwner.get(id) ?? this._conn
    if (!conn || conn.dead) {
      throw new Error(`No extension host owns command "${id}"`)
    }
    return conn.commands.$executeContributedCommand(id, args)
  }

  getLanguages(): IExtHostLanguages | undefined {
    return this._conn?.languages
  }

  getDocuments(): IExtHostDocuments | undefined {
    return this._conn?.documents
  }

  private _liveConnections(): HostConnection[] {
    return this._conn && !this._conn.dead ? [this._conn] : []
  }

  // --- Lifecycle: crash detection + restart -------------------------------

  private _onHostExit(evt: ExtHostExitEvent): void {
    const conn = this._byHandle.get(evt.handle)
    if (!conn) return
    this._teardownConnection(conn)

    const planned = this._stopping.delete(evt.handle)
    const abnormal = evt.code !== 0 && evt.code !== null
    this._logger.warn(
      `extension host exited handle=${evt.handle} code=${evt.code} signal=${evt.signal}` +
        (evt.error ? ` error=${evt.error}` : ''),
    )
    if (!planned && abnormal) {
      this._handleCrash(evt)
    }
  }

  /** Drop the connection from all routing tables and dispose its channels. */
  private _teardownConnection(conn: HostConnection): void {
    conn.markDead()
    this._byHandle.delete(conn.handle)
    this._contributionsByHandle.delete(conn.handle)
    for (const [id, owner] of this._commandOwner) {
      if (owner === conn) this._commandOwner.delete(id)
    }
    if (this._conn === conn) {
      this._conn = undefined
      this._starting = undefined
    }
    // Fire-and-forget $unregisterSourceControl messages from the dying host may
    // be lost when the IPC channel closes. Reset SCM + timeline + tree-view +
    // webview state eagerly so the views don't show stale providers from the
    // previous workspace.
    this._scm.resetSourceControls()
    this._timeline.reset()
    this._treeViews.reset()
    this._webview.reset(conn.kind)
    conn.dispose()
  }

  private _handleCrash(evt: ExtHostExitEvent): void {
    const state = this._restartState
    const now = Date.now()
    if (now - state.windowStart > RESTART_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    state.count++

    if (state.count > MAX_RESTARTS) {
      this._notification.notify({
        severity: Severity.Error,
        message: localize(
          'extHost.crash.noMoreRestarts',
          "The extension host keeps crashing (code {code}) and won't be restarted automatically.",
          { code: evt.code ?? 'n/a' },
        ),
        actions: [
          {
            label: localize('common.restart', 'Restart'),
            run: () => {
              state.count = 0
              void this._restart()
            },
          },
        ],
      })
      return
    }

    this._notification.notify({
      severity: Severity.Warning,
      message: localize(
        'extHost.crash.restarting',
        'The extension host crashed (code {code}). Restarting…',
        {
          code: evt.code ?? 'n/a',
        },
      ),
    })
    const delay = RESTART_BASE_DELAY_MS * 2 ** (state.count - 1)
    setTimeout(() => void this._restart(), delay)
  }

  private async _onEnablementChanged(): Promise<void> {
    // Enablement changed (an extension was enabled/disabled, globally or for this
    // workspace). Relaunch the host only when the effective disabled set actually
    // changed — restarting needlessly would kill + respawn tsserver. If the host
    // isn't running yet (all extensions were disabled before), clear the memoized
    // start; `_restart` skips the stop when there's no live connection.
    await Promise.allSettled([this._starting])

    const sig = disabledSignature(await this._disabledIds())
    if (sig !== this._launchedDisabledIds) {
      if (!this._conn) this._starting = undefined
      await this._restart('workspace')
    }
  }

  private _onWorkspaceChanged(): void {
    // The host pins the workspace folder at launch; relaunch so `workspace.rootPath`
    // updates. Arm the re-pin barrier synchronously (before the first await) so a
    // command firing on the same event turn — e.g. the update-links-on-rename flush
    // debounced off the same file-operation burst that swapped the workspace —
    // blocks on `_whenReady` until the host is re-pinned, rather than racing this
    // async relaunch and reading the previous (often empty) workspace's scan.
    const previous = this._repinning
    const done = (async () => {
      if (previous) await previous
      await this._repin()
    })()
    this._repinning = done
    void done.finally(() => {
      if (this._repinning === done) this._repinning = undefined
    })
  }

  private async _repin(): Promise<void> {
    // A swap can land while the initial boot is still spawning — the Electron-as-node
    // spawn is slow enough on Windows CI to widen this window. At that point
    // `this._conn` isn't assigned yet (the `_connect` await hasn't returned), so
    // reading it directly would drop the swap and leave the host pinned to the
    // launch-time (empty) workspace forever — git then sees no rootPath and never
    // registers its SCM provider. Wait for any in-flight start to settle first so the
    // relaunch sees the freshly-connected host.
    await Promise.allSettled([this._starting])
    // Skip the restart when the live host is already pinned to the current
    // workspace — e.g. the app was launched with the folder as a positional arg,
    // so the first host spawned with it and the boot-time workspace event is a
    // no-op. Restarting anyway would needlessly kill + respawn tsserver.
    if (this._conn && this._conn.workspaceRoot !== this._workspace.current?.folder.fsPath) {
      await this._restart('workspace')
    }
  }

  /** Stop (if alive) and relaunch the host, then re-index and re-run startup activation. */
  private _restart(reason: 'crash' | 'workspace' = 'crash'): Promise<void> {
    const run = this._restartQueue.then(() =>
      this._doRestart(reason).catch((err: unknown) => {
        this._logger.warn(`extension host restart (${reason}) failed: ${(err as Error).message}`)
      }),
    )
    this._restartQueue = run
    return run
  }

  private async _doRestart(reason: 'crash' | 'workspace'): Promise<void> {
    const current = this._conn
    if (current && reason === 'workspace') {
      this._stopping.add(current.handle)
      await this._host.stop(current.handle)
      this._teardownConnection(current)
    }

    this._starting = this._connect().catch((err: unknown) => {
      this._starting = undefined
      throw err
    })
    try {
      await this._starting
    } catch (err) {
      this._logger.warn(`extension host restart failed: ${(err as Error).message}`)
      return
    }

    const conn = this._conn
    if (!conn) return
    try {
      await this._fetchAndIndex(conn)
      // Re-translate before activation: the new host's commands must be back in the
      // core registries before any onCommand proxy can be hit. This also recovers
      // the case where a workspace swap raced — and aborted — the initial boot's
      // one-shot translation, leaving contributed commands unregistered.
      this._onDidChangeContributions.fire(this._mergedContributions())
      await conn.extensions.$activateByEvent(STARTUP_ACTIVATION)
      await conn.extensions.$activateByEvent(STARTUP_FINISHED_ACTIVATION)
    } catch (err) {
      // Torn down mid-activation — the host died on its own (the exit handler
      // already queued a recovery restart) or a stop raced us. Nothing to retry.
      if (conn.dead) {
        this._logger.info(`extension host restart (${reason}) superseded by a teardown`)
        return
      }
      throw err
    }
    this._logger.info(`extension host restarted (${reason})`)
  }
}

/** Order-independent signature of a disabled-id set, for cheap change detection. */
function disabledSignature(ids: readonly string[]): string {
  return [...ids].sort().join(',')
}
