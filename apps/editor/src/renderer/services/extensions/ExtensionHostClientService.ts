/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side owner of the Extension Host connections. Runs two trust tiers:
 *  a `trusted` host for built-in extensions (raw Node, SCM) and a `restricted`
 *  host for external extensions (filesystem only via the gated gateway). Each is
 *  a HostConnection over its own stdio RPC.
 *
 *  Responsibilities beyond wiring (which lives in HostConnection): lazy start of
 *  both tiers, merging their contributions, routing contributed-command
 *  execution to the owning tier, and lifecycle — crash detection with bounded
 *  restart, plus a coordinated restart when the workspace folder changes (the
 *  host pins the folder at launch, so a swap requires a relaunch).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IAiModelService,
  ICommandService,
  IDialogService,
  IEditorService,
  IFileService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IStatusBarService,
  IStorageService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  Severity,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import {
  STARTUP_ACTIVATION,
  STARTUP_FINISHED_ACTIVATION,
  type IExtHostDocuments,
  type IExtHostLanguages,
  type IExtensionDescriptionDto,
} from '@universe-editor/extensions-common'
import {
  IExtensionHostService,
  type ExtHostExitEvent,
  type ExtHostKind,
  type ExtHostStartSpec,
} from '../../../shared/ipc/extensionHostService.js'
import { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import { IAcpPathPolicy } from '../acp/acpPathPolicy.js'
import { getCurrentLocale } from '../../../shared/i18n/availableLocales.js'
import { IScmService } from './ScmService.js'
import { HostConnection, type HostConnectionDeps } from './HostConnection.js'

export interface IExtensionHostClientService {
  readonly _serviceBrand: undefined
  /** Spawn both host tiers and connect their RPC. Idempotent per tier. */
  start(): Promise<void>
  /** All scanned extensions' static contributions across both tiers, for the translator. */
  getContributions(): Promise<IExtensionDescriptionDto[]>
  /**
   * Fires the merged static contributions whenever the live host set changes —
   * i.e. after a tier is relaunched (workspace swap or crash recovery). The
   * translator re-applies them so contributed commands survive a restart that
   * raced the initial boot's one-shot translation.
   */
  readonly onDidChangeContributions: Event<readonly IExtensionDescriptionDto[]>
  /** Activate every extension whose activationEvents match `event`, in both tiers. */
  activateByEvent(event: string): Promise<void>
  /** Execute a command contributed by an activated extension, via its owning tier. */
  executeContributedCommand(id: string, args: unknown[]): Promise<unknown>
  /** The trusted host's language RPC proxy, once connected (trusted-only). */
  getTrustedLanguages(): IExtHostLanguages | undefined
  /** The trusted host's document-mirror RPC proxy, once connected (trusted-only). */
  getTrustedDocuments(): IExtHostDocuments | undefined
}

export const IExtensionHostClientService = createDecorator<IExtensionHostClientService>(
  'extensionHostClientService',
)

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BASE_DELAY_MS = 1_000

interface RestartState {
  windowStart: number
  count: number
}

export class ExtensionHostClientService extends Disposable implements IExtensionHostClientService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private _trusted: HostConnection | undefined
  private _restricted: HostConnection | undefined
  private _startingTrusted: Promise<void> | undefined
  private _startingRestricted: Promise<void> | undefined

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
  /** Handles we asked to stop (planned restarts) — their exit must not trigger crash handling. */
  private readonly _stopping = new Set<string>()
  private readonly _restartState: Record<ExtHostKind, RestartState> = {
    trusted: { windowStart: 0, count: 0 },
    restricted: { windowStart: 0, count: 0 },
  }

  constructor(
    @IExtensionHostService private readonly _host: IExtensionHostService,
    @IOutputService private readonly _output: IOutputService,
    @ILoggerService loggerService: ILoggerService,
    @INotificationService private readonly _notification: INotificationService,
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IDialogService private readonly _dialog: IDialogService,
    @IScmService private readonly _scm: IScmService,
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
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'extHostClient', name: 'Extension Host' })
    this._register(this._host.onExit((evt) => this._onHostExit(evt)))
    this._register(this._workspace.onDidChangeWorkspace(() => void this._onWorkspaceChanged()))

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
    return Promise.allSettled([this._startTrusted(), this._startRestricted()]).then(() => undefined)
  }

  private _startTrusted(): Promise<void> {
    if (!this._startingTrusted) {
      this._startingTrusted = this._connect('trusted').catch((err: unknown) => {
        this._startingTrusted = undefined
        throw err
      })
    }
    return this._startingTrusted
  }

  private _startRestricted(): Promise<void> {
    if (!this._startingRestricted) {
      this._startingRestricted = this._connectRestricted().catch((err: unknown) => {
        // External extensions are optional — a failed restricted host must never
        // take down the workbench or the trusted tier.
        this._startingRestricted = undefined
        this._logger.warn(`restricted extension host unavailable: ${(err as Error).message}`)
      })
    }
    return this._startingRestricted
  }

  private async _connectRestricted(): Promise<void> {
    // Skip the second process entirely when there are no external extensions.
    if (!(await this._host.hasUserExtensions())) {
      this._logger.info('no external extensions installed; restricted host not started')
      return
    }
    await this._connect('restricted')
  }

  private async _connect(kind: ExtHostKind): Promise<void> {
    await this._workspace.whenReady
    const workspaceRoot = this._workspace.current?.folder.fsPath
    const spec: ExtHostStartSpec = {
      kind,
      locale: getCurrentLocale(),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    }
    const { handle } = await this._host.start(spec)

    const stderr = this._output.createChannel(
      kind === 'trusted' ? 'Extension Host' : 'Extension Host (External)',
    )
    const deps: HostConnectionDeps = {
      host: this._host,
      notification: this._notification,
      quickInput: this._quickInput,
      statusBar: this._statusBar,
      dialog: this._dialog,
      files: this._files,
      pathPolicy: this._pathPolicy,
      commandService: this._commandService,
      storage: this._storage,
      ...(kind === 'trusted'
        ? {
            scm: this._scm,
            languageFeatures: this._languageFeatures,
            editorService: this._editorService,
            uriIdentity: this._uriIdentity,
            aiModel: this._aiModel,
          }
        : {}),
      output: this._output,
      layout: this._layout,
      views: this._views,
      stderr,
      logger: this._logger,
      ledger: {
        claim: (id) => this._claimCommand(id, kind),
        release: (id) => this._commandOwner.delete(id),
      },
    }

    const connection = this._register(new HostConnection(kind, handle, workspaceRoot, deps))
    this._byHandle.set(handle, connection)
    if (kind === 'trusted') this._trusted = connection
    else this._restricted = connection
    this._logger.info(`${kind} extension host connected handle=${handle}`)
  }

  private _claimCommand(id: string, kind: ExtHostKind): void {
    const conn = kind === 'trusted' ? this._trusted : this._restricted
    if (conn) this._commandOwner.set(id, conn)
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
    await this.start()
    await Promise.all(this._liveConnections().map((c) => c.extensions.$activateByEvent(event)))
  }

  async executeContributedCommand(id: string, args: unknown[]): Promise<unknown> {
    await this.start()
    const conn = this._commandOwner.get(id) ?? this._trusted
    if (!conn || conn.dead) {
      throw new Error(`No extension host owns command "${id}"`)
    }
    return conn.commands.$executeContributedCommand(id, args)
  }

  getTrustedLanguages(): IExtHostLanguages | undefined {
    return this._trusted?.languages
  }

  getTrustedDocuments(): IExtHostDocuments | undefined {
    return this._trusted?.documents
  }

  private _liveConnections(): HostConnection[] {
    return [this._trusted, this._restricted].filter(
      (c): c is HostConnection => c !== undefined && !c.dead,
    )
  }

  // --- Lifecycle: crash detection + restart -------------------------------

  private _onHostExit(evt: ExtHostExitEvent): void {
    const conn = this._byHandle.get(evt.handle)
    if (!conn) return
    this._teardownConnection(conn)

    const planned = this._stopping.delete(evt.handle)
    const abnormal = evt.code !== 0 && evt.code !== null
    this._logger.warn(
      `${conn.kind} extension host exited handle=${evt.handle} code=${evt.code} signal=${evt.signal}` +
        (evt.error ? ` error=${evt.error}` : ''),
    )
    if (!planned && abnormal) {
      this._handleCrash(conn.kind, evt)
    }
  }

  /** Drop a connection from all routing tables and dispose its channels. */
  private _teardownConnection(conn: HostConnection): void {
    conn.markDead()
    this._byHandle.delete(conn.handle)
    this._contributionsByHandle.delete(conn.handle)
    for (const [id, owner] of this._commandOwner) {
      if (owner === conn) this._commandOwner.delete(id)
    }
    if (this._trusted === conn) {
      this._trusted = undefined
      this._startingTrusted = undefined
    }
    if (this._restricted === conn) {
      this._restricted = undefined
      this._startingRestricted = undefined
    }
    // Fire-and-forget $unregisterSourceControl messages from the dying host may
    // be lost when the IPC channel closes. Reset SCM state eagerly so the view
    // doesn't show stale source controls from the previous workspace.
    this._scm.resetSourceControls()
    conn.dispose()
  }

  private _handleCrash(kind: ExtHostKind, evt: ExtHostExitEvent): void {
    const state = this._restartState[kind]
    const now = Date.now()
    if (now - state.windowStart > RESTART_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    state.count++

    if (state.count > MAX_RESTARTS) {
      this._notification.notify({
        severity: Severity.Error,
        message: `The ${kind} extension host keeps crashing (code ${evt.code ?? 'n/a'}) and won't be restarted automatically.`,
        actions: [
          {
            label: 'Restart',
            run: () => {
              state.count = 0
              void this._restart(kind)
            },
          },
        ],
      })
      return
    }

    this._notification.notify({
      severity: Severity.Warning,
      message: `The ${kind} extension host crashed (code ${evt.code ?? 'n/a'}). Restarting…`,
    })
    const delay = RESTART_BASE_DELAY_MS * 2 ** (state.count - 1)
    setTimeout(() => void this._restart(kind), delay)
  }

  private async _onWorkspaceChanged(): Promise<void> {
    // The host pins the workspace folder at launch; relaunch live tiers so
    // `workspace.rootPath` and the fs gateway's containment root update.
    //
    // A swap can land while the initial boot is still spawning a tier — the
    // Electron-as-node spawn is slow enough on Windows CI to widen this window.
    // At that point `this._trusted` isn't assigned yet (the `_connect` await
    // hasn't returned), so reading it directly would drop the swap and leave the
    // host pinned to the launch-time (empty) workspace forever — git then sees no
    // rootPath and never registers its SCM provider. Wait for any in-flight start
    // to settle first so the relaunch sees the freshly-connected tiers.
    await Promise.allSettled([this._startingTrusted, this._startingRestricted])
    const kinds: ExtHostKind[] = []
    if (this._trusted) kinds.push('trusted')
    if (this._restricted) kinds.push('restricted')
    for (const kind of kinds) {
      await this._restart(kind, 'workspace')
    }
  }

  /** Stop (if alive) and relaunch a tier, then re-index and re-run startup activation. */
  private async _restart(
    kind: ExtHostKind,
    reason: 'crash' | 'workspace' = 'crash',
  ): Promise<void> {
    const current = kind === 'trusted' ? this._trusted : this._restricted
    if (current && reason === 'workspace') {
      this._stopping.add(current.handle)
      await this._host.stop(current.handle)
      this._teardownConnection(current)
    }

    try {
      if (kind === 'trusted') await this._startTrusted()
      else await this._startRestricted()
    } catch (err) {
      this._logger.warn(`${kind} extension host restart failed: ${(err as Error).message}`)
      return
    }

    const conn = kind === 'trusted' ? this._trusted : this._restricted
    if (!conn) return
    await this._fetchAndIndex(conn)
    // Re-translate before activation: the new host's commands must be back in the
    // core registries before any onCommand proxy can be hit. This also recovers
    // the case where a workspace swap raced — and aborted — the initial boot's
    // one-shot translation, leaving contributed commands unregistered.
    this._onDidChangeContributions.fire(this._mergedContributions())
    await conn.extensions.$activateByEvent(STARTUP_ACTIVATION)
    await conn.extensions.$activateByEvent(STARTUP_FINISHED_ACTIVATION)
    this._logger.info(`${kind} extension host restarted (${reason})`)
  }
}
