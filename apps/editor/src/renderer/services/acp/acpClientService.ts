/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpClientService — connection-pooled ACP client.
 *
 *  Same (agentId, cwd) shares one ClientSideConnection backed by one agent
 *  subprocess. Each caller (a session or a hydrate sweep) gets a refcounted
 *  "lease". When all leases are released the pool entry enters a short grace
 *  window (POOL_GRACE_MS); a re-acquire during grace reuses the connection,
 *  otherwise the process is stopped and the entry evicted.
 *
 *  Notification routing is owned by a single `IAcpClientNotificationSink`
 *  (`AcpSessionService`), installed once via `setNotificationSink`. The sink
 *  is sessionId-aware, so a shared connection's sessionUpdate / requestPermission
 *  fan out correctly across leases.
 *
 *  Terminal ownership is tracked per `sessionId` (the leaseFor) so multiple
 *  sessions sharing a connection cannot reach each other's terminals, and a
 *  single lease.dispose() reaps only its own terminals.
 *
 *  All fs/* requests are gated through IAcpPathPolicy against the pool entry's
 *  cwd. Anything outside cwd or under a sensitive prefix fails closed.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  DisposableStore,
  ILifecycleService,
  ILoggerService,
  IConfigurationService,
  IFileService,
  INotificationService,
  IProgressService,
  ITelemetryService,
  IUriIdentityService,
  ProgressLocation,
  REMOTE_SCHEME,
  Severity,
  URI,
} from '@universe-editor/platform'
import type { HostPlatform, IDisposable, ILogger, IOutputChannel } from '@universe-editor/platform'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeRequest,
  type InitializeResponse,
  type KillTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import {
  IAcpHostService,
  type AcpExitEvent,
  type AcpLaunchSpec,
} from '../../../shared/ipc/acpHostService.js'
import { IAcpTerminalService } from '../../../shared/ipc/acpTerminalService.js'
import {
  IClaudeBinaryService,
  type ClaudeBinarySource,
  type IClaudeBinaryResolveOptions,
} from '../../../shared/ipc/claudeBinaryService.js'
import {
  ICodexBinaryService,
  type CodexBinarySource,
  type ICodexBinaryResolveOptions,
} from '../../../shared/ipc/codexBinaryService.js'
import { IClaudeConfigService } from '../../../shared/ipc/claudeConfigService.js'
import { IRemoteStatusService } from '../../../shared/ipc/remoteStatusService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPathPolicy, type AcpPathPolicyEnv } from './acpPathPolicy.js'
import { SUBAGENT_TRANSCRIPT_CAPABILITY } from './session/acpExtMethods.js'
import { createSdkHostStream, type SdkHostStream } from './sdkHostStream.js'
import { AcpProtocolTracer } from './acpProtocolTracer.js'
import type { ISessionCreateProfileHandle } from './acpSessionCreateProfiler.js'
import { IOutputService } from '@universe-editor/platform'

export interface IAcpClientNotificationSink {
  onSessionUpdate(params: SessionNotification): void
  /**
   * Peer-initiated `session/request_permission`. The sink owns the UX
   * (inline-in-chat card today) and the autoApprove short-circuit.
   */
  onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  /**
   * Peer-initiated `elicitation/create` (UNSTABLE). The sink presents the form
   * card (or URL consent) inline in the session and resolves with the user's
   * three-state response (`accept` + content / `decline` / `cancel`).
   */
  onCreateElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
  /**
   * Peer-initiated `elicitation/complete` notification (UNSTABLE, url mode) —
   * the server-side flow finished. Optional until url mode is wired up.
   */
  onCompleteElicitation?(params: CompleteElicitationNotification): void
  /**
   * Peer-initiated `extNotification` — an out-of-spec one-way notification. The
   * built-in agent uses `_claude/sdkMessage` to forward raw Claude SDK messages
   * (e.g. the system-init MCP server snapshot). Optional: unknown methods are
   * ignored by the sink.
   */
  onExtNotification?(method: string, params: Record<string, unknown>): void
}

export interface IAcpClientConnection {
  readonly conn: ClientSideConnection
  /** Resolves to the pool's cached `initialize()` response. */
  readonly initializeResult: Promise<InitializeResponse>
  /**
   * Tag this lease with its `sessionIdOnAgent`. Terminals opened by the agent
   * under that sessionId become the lease's property and are released on
   * `dispose()`. Callers without an established session (hydrate sweeps) may
   * skip this. Idempotent — only the first call takes effect.
   */
  attachSession(sessionIdOnAgent: string): void
  /** Release this lease. Idempotent. Does not stop the process unless this is the last lease. */
  dispose(): void
}

export interface IAcpClientService {
  readonly _serviceBrand: undefined
  /**
   * Install the notification sink. Must be called once at bootstrap before any
   * `connect()` lease is awaited. The sink is shared across every lease — it
   * routes incoming `session/update` / `session/request_permission` by
   * sessionId, so a single sink supports a shared connection.
   */
  setNotificationSink(sink: IAcpClientNotificationSink): void
  /**
   * Acquire a connection lease for `agentId` rooted at `options.cwd`. If a live
   * pool entry exists, it is reused; otherwise a new agent process is spawned
   * and ACP `initialize` is run once and cached.
   *
   * `options.leaseFor` should be the `sessionIdOnAgent` the lease will be used
   * for, when known up-front (e.g. `resumeSession`). For paths that learn the
   * sessionId only after `newSession()` returns, omit it here and call
   * `lease.attachSession(sessionId)` once it's known.
   *
   * `options.silent` suppresses the user-facing error notification on spawn
   * failure — for background/best-effort callers (hydrate sweeps, opportunistic
   * `deleteOnAgent`) that already treat failure as non-fatal and don't want a
   * spurious "Failed to start agent" toast for an agent the user never
   * explicitly asked to start. The failure still throws and is still logged to
   * telemetry; only the notification is skipped. Only takes effect when this
   * call spawns a brand-new pool entry — a concurrent call sharing an in-flight
   * spawn defers to whichever caller triggered the spawn first.
   *
   * `options.profile` (createSession only) receives per-attempt timing steps:
   * pool hits are tagged via `markPooled()`, a fresh spawn records
   * binary-resolve / spawn / initialize segments.
   */
  connect(
    agentId: string,
    options?: {
      cwd?: string
      /** `remote-ssh` authority to spawn on; absent → local. */
      authority?: string
      leaseFor?: string
      silent?: boolean
      profile?: ISessionCreateProfileHandle
    },
  ): Promise<IAcpClientConnection>
  /** Synchronously stop every pooled process and clear the pool. */
  drainAll(): void
  /**
   * Forcibly stop the pooled process for one (agentId, cwd) and drop its entry,
   * so the next `connect()` spawns a fresh process. Used by stall recovery: the
   * process is alive but its turn is wedged, and reusing it via the pool would
   * reconnect to the same wedged state. No live entry → no-op.
   */
  killConnectionFor(agentId: string, cwd: string | undefined, authority?: string): void
}

export const IAcpClientService = createDecorator<IAcpClientService>('acpClientService')

/** Grace period after the last lease is released before the agent process is stopped. */
const POOL_GRACE_MS = 30_000

/**
 * Upper bound on the ACP `initialize` handshake before a pooled entry is torn
 * down. A hung handshake must not wedge the pool: without this, a `connect()`
 * awaiting `entry.initializeResult` never returns, so a resume stalls before
 * `session/load` and spins forever. Overridable via `acp.startupTimeoutMs`.
 * Note: this bounds only the post-spawn handshake — the (potentially minutes-
 * long) binary download lives in `_createEntry`/`await entryPromise`, ahead of
 * this await, and stays intentionally untimed.
 */
const DEFAULT_INIT_TIMEOUT_MS = 60_000

/** Bounded tail of agent stderr retained per entry, surfaced on initialize failure. */
const STDERR_TAIL_LIMIT = 8_192

const TERMINAL_BUCKET_UNTAGGED = '\0__untagged__'

const DEFAULT_INIT_PARAMS: InitializeRequest = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    // Advertise terminal-auth support so the agent offers `claude auth login`
    // methods in its InitializeResponse. The editor runs the login flow in its
    // integrated terminal (see Agent Settings → Authentication).
    auth: { terminal: true, _meta: { 'terminal-auth': true } },
    // UNSTABLE elicitation: form (rendered as a field card) + url (consent
    // card → open-in-browser → elicitation/complete) are both wired.
    elicitation: { form: {}, url: {} },
    // Sub-agent transcript: lets the claude fork relay sub-agent text/thinking
    // chunks (parentToolUseId) instead of stripping them.
    _meta: { [SUBAGENT_TRANSCRIPT_CAPABILITY]: true },
  },
}

/** Exported for tests — verifies the capability surface we put on the wire. */
export function getDefaultInitParamsForTests(): InitializeRequest {
  return DEFAULT_INIT_PARAMS
}

interface PoolEntry {
  readonly key: string
  readonly agentId: string
  readonly cwd: string
  /** `remote-ssh` authority; empty string for local. */
  readonly authority: string
  /** Resolved remote platform/home for fs/* path checks; undefined for local. */
  readonly remoteEnv: AcpPathPolicyEnv | undefined
  readonly handle: string
  readonly conn: ClientSideConnection
  readonly initializeResult: Promise<InitializeResponse>
  readonly stderr: IOutputChannel
  readonly stderrSub: IDisposable
  readonly hostStream: SdkHostStream
  readonly tracer: AcpProtocolTracer
  /** Per-entry store rooted under AcpClientService — owns stderrSub + hostStream
   *  so their internal event subscriptions appear under a singleton parent chain. */
  readonly entryStore: DisposableStore
  /** sessionId → terminalIds owned by leases tagged with that sessionId. */
  readonly terminalsBySession: Map<string, Set<string>>
  refcount: number
  graceTimer: ReturnType<typeof setTimeout> | undefined
  evicted: boolean
}

export class AcpClientService extends Disposable implements IAcpClientService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _protocolLogger: ILogger
  /** Maps pool-key → in-flight or settled PoolEntry. Stored as Promise so
   *  concurrent `connect()` calls share the same spawn. On creation failure
   *  the catch handler evicts the entry. */
  private readonly _pool = new Map<string, Promise<PoolEntry>>()
  /** Resolved spawn handles still alive, tracked synchronously so a window
   *  reload's `beforeunload` can kill the child processes without awaiting the
   *  Promise-keyed `_pool`. Without this, a reload orphans every agent child
   *  (main holds their stdin open) until app quit — they pile up across the
   *  shared-app E2E suite and starve later spawns. */
  private readonly _liveHandles = new Set<string>()
  private readonly _entriesStore = this._register(new DisposableStore())
  private _sink: IAcpClientNotificationSink | undefined
  private _protocolChannel: IOutputChannel | undefined

  constructor(
    @IAcpHostService private readonly _host: IAcpHostService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IAcpPathPolicy private readonly _pathPolicy: IAcpPathPolicy,
    @IFileService private readonly _files: IFileService,
    @IOutputService private readonly _output: IOutputService,
    @INotificationService private readonly _notification: INotificationService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @IAcpTerminalService private readonly _terminals: IAcpTerminalService,
    @IClaudeBinaryService private readonly _claudeBinary: IClaudeBinaryService,
    @ICodexBinaryService private readonly _codexBinary: ICodexBinaryService,
    @IClaudeConfigService private readonly _claudeConfig: IClaudeConfigService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IProgressService private readonly _progress: IProgressService,
    @ILoggerService loggerService: ILoggerService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @ILifecycleService lifecycleService: ILifecycleService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpClient', name: 'ACP Client' })
    this._protocolLogger = loggerService.createLogger({
      id: 'acpProtocol',
      name: 'ACP Protocol',
    })

    // A window reload destroys this renderer without disposing its services
    // (that's what the leak detector watches for), so the async dispose() path
    // below never runs on reload. Synchronously stop every live child here:
    // ProxyChannel dispatches host.stop via ipcRenderer.send before teardown,
    // so main reaps the processes instead of leaking them until app quit.
    if (typeof window !== 'undefined') {
      const onBeforeUnload = (): void => {
        for (const handle of this._liveHandles) {
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

    // Window close / app quit: stop every agent child via the will-shutdown
    // join phase. This is the RELIABLE path — the window stays alive until all
    // joins resolve, so the stop IPC actually lands (beforeunload above is
    // fire-and-forget and its sends can be dropped mid-teardown). Without this
    // a shell-wrapped agent (cmd.exe → node.exe) survives the window close with
    // its cwd pinned to the workspace folder, making that folder undeletable
    // on Windows until the whole app exits.
    this._register(
      lifecycleService.onWillShutdown((e) =>
        e.join(
          Promise.allSettled([...this._liveHandles].map((handle) => this._host.stop(handle))).then(
            () => undefined,
          ),
          'acp.stopAgents',
        ),
      ),
    )
  }

  override dispose(): void {
    // Fire host.stop best-effort for every resolved entry. _entriesStore (via
    // super.dispose) tears down all per-entry subscriptions synchronously.
    for (const entryPromise of [...this._pool.values()]) {
      entryPromise.then(
        (entry) => {
          if (!entry.evicted) {
            entry.evicted = true
            void this._host.stop(entry.handle).catch(() => {
              // best-effort
            })
            if (entry.graceTimer !== undefined) {
              clearTimeout(entry.graceTimer)
            }
          }
        },
        () => {
          // spawn failed — already self-evicted
        },
      )
    }
    this._pool.clear()
    this._liveHandles.clear()
    super.dispose()
  }

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  async connect(
    agentId: string,
    options?: {
      cwd?: string
      authority?: string
      leaseFor?: string
      silent?: boolean
      profile?: ISessionCreateProfileHandle
    },
  ): Promise<IAcpClientConnection> {
    if (!this._sink) {
      throw new Error('AcpClientService.connect: notification sink not installed')
    }
    const cwd = options?.cwd ?? ''
    const authority = options?.authority ?? ''
    const key = this._poolKey(agentId, cwd, authority)
    let entryPromise = this._pool.get(key)
    if (!entryPromise) {
      entryPromise = this._createEntry(
        agentId,
        key,
        cwd,
        authority,
        options?.silent ?? false,
        options?.profile,
      )
      this._pool.set(key, entryPromise)
      // If spawn fails, drop the entry so the next caller retries.
      entryPromise.catch(() => {
        if (this._pool.get(key) === entryPromise) this._pool.delete(key)
      })
    } else {
      options?.profile?.markPooled()
    }
    const entry = await entryPromise
    if (entry.evicted) {
      // Lost the race to a concurrent eviction. Retry — fresh entry will be
      // created on this call.
      return this.connect(agentId, options)
    }
    if (entry.graceTimer !== undefined) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = undefined
    }
    entry.refcount++
    const initTimeoutMs =
      this._config.get<number>('acp.startupTimeoutMs') ?? DEFAULT_INIT_TIMEOUT_MS
    try {
      options?.profile?.step('willInitialize')
      await withTimeout(entry.initializeResult, initTimeoutMs, 'ACP initialize')
      options?.profile?.step('didInitialize')
    } catch (err) {
      entry.refcount--
      // A *rejected* handshake already self-evicted via _createEntry's catch; a
      // *hung* one has not. Evict here too (idempotent) so the next connect()
      // re-spawns instead of awaiting the same dead promise forever — the
      // root of the "Resuming agent session…" spinner that never settles.
      this._evictNow(entry)
      throw err
    }
    return this._createLease(entry, options?.leaseFor)
  }

  drainAll(): void {
    for (const entryPromise of [...this._pool.values()]) {
      entryPromise.then(
        (entry) => this._evictNow(entry),
        () => {
          // Spawn failed — already self-evicted via the catch in connect().
        },
      )
    }
  }

  killConnectionFor(agentId: string, cwd: string | undefined, authority?: string): void {
    const entryPromise = this._pool.get(this._poolKey(agentId, cwd ?? '', authority ?? ''))
    entryPromise?.then(
      (entry) => this._evictNow(entry),
      () => {
        // Spawn failed — already self-evicted via the catch in connect().
      },
    )
  }

  // -- internals -----------------------------------------------------------

  private _getProtocolChannel(): IOutputChannel {
    if (!this._protocolChannel) {
      this._protocolChannel = this._output.createChannel('acp/protocol')
    }
    return this._protocolChannel
  }

  private _poolKey(agentId: string, cwd: string, authority: string): string {
    if (!authority && !cwd) return `${agentId} `
    const scope = authority ? `remote:${authority}` : ''
    if (!cwd) return `${agentId} ${scope}`
    return `${agentId} ${scope} ${this._uriIdentity.getPathComparisonKey(cwd)}`
  }

  /**
   * For the built-in Claude agent (runAsNode), the ~226MB native binary is not
   * shipped — resolve it (download on first use / system install / custom path)
   * and inject its absolute path via CLAUDE_CODE_EXECUTABLE. Shows a progress
   * notification while a download is in flight. Non-runAsNode agents pass
   * through untouched.
   */
  private async _ensureClaudeBinary(
    spec: AcpLaunchSpec,
    agentId: string,
    silent: boolean,
  ): Promise<AcpLaunchSpec> {
    if (agentId !== 'claude-code') return spec
    // Remote spawns resolve the binary on the remote host (PATH probe / its own
    // download) — never pull the local binary or local credentials through.
    if (spec.authority) return spec
    const source = (this._config.get<string>('acp.claude.source') ??
      'download') as ClaudeBinarySource
    const customPath = this._config.get<string>('acp.claude.executablePath') ?? ''
    const opts: IClaudeBinaryResolveOptions =
      source === 'custom'
        ? { source, customPath, allowDownload: !silent }
        : { source, allowDownload: !silent }

    const result = await this._progress.withProgress(
      { location: ProgressLocation.Notification, title: 'Preparing Claude…', source: 'acp' },
      async (progress) => {
        let lastPct = 0
        const sub = this._entriesStore.add(
          this._claudeBinary.onDidChangeProgress(({ received, total }) => {
            if (total > 0) {
              const pct = Math.min(100, Math.floor((received / total) * 100))
              progress.report({
                message: `Downloading Claude binary… ${pct}%`,
                increment: pct - lastPct,
              })
              lastPct = pct
            } else {
              progress.report({
                message: `Downloading Claude binary… ${Math.floor(received / 1048576)} MB`,
              })
            }
          }),
        )
        try {
          return await this._claudeBinary.resolve(opts)
        } finally {
          this._entriesStore.delete(sub)
        }
      },
    )
    // The native CLI's first-run onboarding decides whether to auto-start the
    // OAuth browser flow by probing process env only — it never sees the
    // settings.json env block. Inject that block into the agent process env so
    // a configured gateway token suppresses the spurious browser login on a
    // fresh machine. spec.env wins so explicit overrides are never clobbered.
    const settingsEnv = await this._readClaudeSettingsEnv()
    return {
      ...spec,
      env: { ...settingsEnv, ...spec.env, CLAUDE_CODE_EXECUTABLE: result.path },
    }
  }

  private async _readClaudeSettingsEnv(): Promise<Record<string, string>> {
    try {
      const settings = await this._claudeConfig.read()
      return settings.env ?? {}
    } catch (err) {
      this._logger.warn(`reading claude settings env failed: ${(err as Error).message}`)
      return {}
    }
  }

  /**
   * For the built-in Codex agent (runAsNode), the bundled codex-acp JS adapter
   * is launched through Electron's Node runtime, but the native `codex` binary it
   * drives is not shipped — resolve it (download on first use / system install /
   * custom path) and inject its absolute path via CODEX_PATH so codex-acp spawns
   * it directly instead of resolving `@openai/codex`'s platform package. Auth is
   * taken from `acp.codex.apiKey` when set, otherwise the child inherits a real
   * OPENAI_API_KEY / CODEX_API_KEY from the environment. Non-codex agents pass
   * through untouched.
   */
  private async _ensureCodexBinary(
    spec: AcpLaunchSpec,
    agentId: string,
    silent: boolean,
  ): Promise<AcpLaunchSpec> {
    if (agentId !== 'codex') return spec
    // Remote spawns resolve the binary on the remote host; never leak the local
    // apiKey config across the tunnel (the remote side uses its own auth).
    if (spec.authority) return spec

    const source = (this._config.get<string>('acp.codex.source') ?? 'download') as CodexBinarySource
    const customPath = this._config.get<string>('acp.codex.executablePath') ?? ''
    const opts: ICodexBinaryResolveOptions =
      source === 'custom'
        ? { source, customPath, allowDownload: !silent }
        : { source, allowDownload: !silent }

    const result = await this._progress.withProgress(
      { location: ProgressLocation.Notification, title: 'Preparing Codex…', source: 'acp' },
      async (progress) => {
        let lastPct = 0
        const sub = this._entriesStore.add(
          this._codexBinary.onDidChangeProgress(({ received, total }) => {
            if (total > 0) {
              const pct = Math.min(100, Math.floor((received / total) * 100))
              progress.report({
                message: `Downloading codex… ${pct}%`,
                increment: pct - lastPct,
              })
              lastPct = pct
            } else {
              progress.report({
                message: `Downloading codex… ${Math.floor(received / 1048576)} MB`,
              })
            }
          }),
        )
        try {
          return await this._codexBinary.resolve(opts)
        } finally {
          this._entriesStore.delete(sub)
        }
      },
    )

    const apiKey = (this._config.get<string>('acp.codex.apiKey') ?? '').trim()
    return {
      ...spec,
      env: {
        ...spec.env,
        CODEX_PATH: result.path,
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      },
    }
  }

  private async _createEntry(
    agentId: string,
    key: string,
    cwd: string,
    authority: string,
    silent: boolean,
    profile?: ISessionCreateProfileHandle,
  ): Promise<PoolEntry> {
    const sink = this._sink!
    let spec = this._registry.resolve(agentId, cwd || undefined)
    if (authority) spec = { ...spec, authority }
    const remoteEnv = authority ? await this._resolveRemotePathEnv(authority) : undefined
    let handle: string
    try {
      profile?.step('willResolveBinary')
      spec = await this._ensureClaudeBinary(spec, agentId, silent)
      spec = await this._ensureCodexBinary(spec, agentId, silent)
      profile?.step('didResolveBinary')
      profile?.step('willSpawn')
      handle = (await this._host.start(spec)).handle
      profile?.step('didSpawn')
    } catch (err) {
      this._telemetry.publicLogError('acp.spawn_failed', {
        agentId,
        error: (err as Error).message,
      })
      if (!silent) {
        this._notification.notify({
          severity: Severity.Error,
          message: `Failed to start agent "${agentId}": ${(err as Error).message}`,
        })
      }
      throw err
    }
    this._logger.info(`spawned agent=${agentId} handle=${handle} cwd=${cwd || '<none>'}`)
    this._telemetry.publicLog('acp.spawned', { agentId })
    this._liveHandles.add(handle)

    const stderr = this._output.createChannel(`acp/${agentId}/${handle}`)
    const entryStore = new DisposableStore()
    this._entriesStore.add(entryStore)
    // Keep a bounded tail of the child's stderr + its exit status so an
    // `initialize` failure ("ACP connection closed") can surface the real
    // reason the subprocess died, instead of just the generic EOF error.
    let stderrTail = ''
    let lastExit: AcpExitEvent | undefined
    const stderrSub = entryStore.add(
      this._host.onStderr((chunk) => {
        if (chunk.handle !== handle) return
        stderr.append(chunk.data)
        stderrTail = (stderrTail + chunk.data).slice(-STDERR_TAIL_LIMIT)
      }),
    )
    entryStore.add(
      this._host.onExit((evt) => {
        if (evt.handle === handle) {
          lastExit = evt
          this._liveHandles.delete(handle)
        }
      }),
    )
    const terminalsBySession = new Map<string, Set<string>>()

    const clientImpl: Client = {
      requestPermission: (params) => sink.onRequestPermission(params),
      unstable_createElicitation: (params) => sink.onCreateElicitation(params),
      unstable_completeElicitation: async (params) => {
        sink.onCompleteElicitation?.(params)
      },
      extMethod: async (method: string): Promise<Record<string, unknown>> => {
        // No client-side ext-methods remain (AskUserQuestion moved to the
        // standard elicitation channel); anything else is out of spec.
        throw RequestError.methodNotFound(method)
      },
      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        sink.onExtNotification?.(method, params)
      },
      sessionUpdate: async (params) => {
        sink.onSessionUpdate(params)
      },
      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        const decision = this._pathPolicy.check(cwd, params.path, remoteEnv)
        if (!decision.ok) {
          this._reportBlockedPath('read', params.path, decision.reason)
          throw RequestError.invalidParams(
            undefined,
            `fs/read_text_file rejected: ${decision.reason}`,
          )
        }
        const uri = authority
          ? URI.from({ scheme: REMOTE_SCHEME, authority, path: decision.normalized })
          : URI.file(decision.normalized)
        const content = await this._files.readFileText(uri)
        const sliced = sliceLines(content, params.line ?? undefined, params.limit ?? undefined)
        return { content: sliced }
      },
      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        const decision = this._pathPolicy.check(cwd, params.path, remoteEnv)
        if (!decision.ok) {
          this._reportBlockedPath('write', params.path, decision.reason)
          throw RequestError.invalidParams(
            undefined,
            `fs/write_text_file rejected: ${decision.reason}`,
          )
        }
        const uri = authority
          ? URI.from({ scheme: REMOTE_SCHEME, authority, path: decision.normalized })
          : URI.file(decision.normalized)
        await this._files.writeFile(uri, params.content)
        return {}
      },
      createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
        const { sessionId, ...rest } = params
        let createSpec: Omit<CreateTerminalRequest, 'sessionId'> = rest
        if (params.cwd != null) {
          const decision = this._pathPolicy.check(cwd, params.cwd, remoteEnv)
          if (!decision.ok) {
            this._reportBlockedPath('terminal-cwd', params.cwd, decision.reason)
            throw RequestError.invalidParams(
              undefined,
              `terminal/create rejected: ${decision.reason}`,
            )
          }
          createSpec = { ...rest, cwd: decision.normalized }
        }
        const created = await this._terminals.create({
          ...createSpec,
          ...(authority ? { authority } : {}),
        })
        bucketFor(terminalsBySession, sessionId).add(created.terminalId)
        this._telemetry.publicLog('acp.terminal_created', { command: params.command })
        return created
      },
      terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        assertTerminalOwned(terminalsBySession, params.sessionId, params.terminalId)
        return this._terminals.output(params.terminalId)
      },
      waitForTerminalExit: async (
        params: WaitForTerminalExitRequest,
      ): Promise<WaitForTerminalExitResponse> => {
        assertTerminalOwned(terminalsBySession, params.sessionId, params.terminalId)
        return this._terminals.waitForExit(params.terminalId)
      },
      killTerminal: async (params: KillTerminalRequest) => {
        assertTerminalOwned(terminalsBySession, params.sessionId, params.terminalId)
        await this._terminals.kill(params.terminalId)
      },
      releaseTerminal: async (params: ReleaseTerminalRequest) => {
        assertTerminalOwned(terminalsBySession, params.sessionId, params.terminalId)
        const bucket = terminalsBySession.get(params.sessionId)
        bucket?.delete(params.terminalId)
        if (bucket && bucket.size === 0) terminalsBySession.delete(params.sessionId)
        await this._terminals.release(params.terminalId)
      },
    }

    const tracer = new AcpProtocolTracer(
      this._getProtocolChannel(),
      this._protocolLogger,
      `${agentId}#${handle.slice(-6)}`,
    )
    const hostStream = entryStore.add(
      createSdkHostStream(this._host, handle, {
        onStdout: (text) => tracer.traceInboundChunk(text),
        onStdin: (text) => tracer.traceOutboundChunk(text),
      }),
    )
    const conn = new ClientSideConnection(() => clientImpl, hostStream.stream)

    const entry: PoolEntry = {
      key,
      agentId,
      cwd,
      authority,
      remoteEnv,
      handle,
      conn,
      stderr,
      stderrSub,
      hostStream,
      tracer,
      entryStore,
      terminalsBySession,
      refcount: 0,
      graceTimer: undefined,
      evicted: false,
      // Filled below — the field is readonly only externally; we patch via the
      // mutable alias before returning.
      initializeResult: undefined as unknown as Promise<InitializeResponse>,
    }

    conn.signal.addEventListener(
      'abort',
      () => {
        // Process died (stop / kill / crash). Drop the entry so the next
        // connect() spawns a fresh process; existing leases will see their
        // sessions seal via the AcpSession's own signal.abort listener.
        this._evictNow(entry)
      },
      { once: true },
    )

    const initializeResult = conn.initialize(DEFAULT_INIT_PARAMS).catch((err: unknown) => {
      const reason = (err as Error).message
      const exitInfo = lastExit
        ? ` exit: code=${lastExit.code} signal=${lastExit.signal}${
            lastExit.error ? ` error=${lastExit.error}` : ''
          }`
        : ''
      const tail = stderrTail.trim()
      this._logger.warn(
        `initialize failed for ${agentId}: ${reason}${exitInfo}${
          tail ? `\n  stderr (tail):\n${tail}` : ''
        }`,
      )
      this._telemetry.publicLogError('acp.initialize_failed', { agentId, error: reason })
      this._notification.notify({
        severity: Severity.Error,
        message: `Agent "${agentId}" failed to start: ${reason}${
          tail ? `\n${tail.split('\n').slice(-5).join('\n')}` : ''
        }`,
      })
      this._evictNow(entry)
      throw err
    })
    // Prevent unhandled-rejection noise if no lease awaits the result (e.g.
    // drainAll arrived first).
    initializeResult.catch(() => {})
    ;(entry as { initializeResult: Promise<InitializeResponse> }).initializeResult =
      initializeResult

    return entry
  }

  private async _resolveRemotePathEnv(authority: string): Promise<AcpPathPolicyEnv | undefined> {
    try {
      const env = await this._remoteStatus.getEnvironment(authority)
      if (!env) return undefined
      const platform: HostPlatform =
        env.os === 'win32' || env.os === 'darwin' || env.os === 'linux' ? env.os : 'linux'
      return { platform, home: env.homeDir }
    } catch {
      // Remote env unavailable — the workspace-root containment check still
      // applies; only the home-sensitive-prefix guard degrades to the local env.
      return undefined
    }
  }

  private _createLease(entry: PoolEntry, leaseFor: string | undefined): IAcpClientConnection {
    let disposed = false
    let tag: string | undefined = leaseFor
    return {
      conn: entry.conn,
      initializeResult: entry.initializeResult,
      attachSession: (sessionIdOnAgent: string): void => {
        if (tag === undefined) tag = sessionIdOnAgent
      },
      dispose: (): void => {
        if (disposed) return
        disposed = true
        this._releaseLease(entry, tag)
      },
    }
  }

  private _releaseLease(entry: PoolEntry, leaseFor: string | undefined): void {
    if (entry.evicted) return
    // Release terminals owned by this lease.
    const bucketKey = leaseFor ?? TERMINAL_BUCKET_UNTAGGED
    const bucket = entry.terminalsBySession.get(bucketKey)
    if (bucket && bucket.size > 0) {
      const ids = [...bucket]
      bucket.clear()
      entry.terminalsBySession.delete(bucketKey)
      for (const id of ids) {
        void this._terminals.release(id).catch(() => {
          // best-effort
        })
      }
    }
    entry.refcount--
    if (entry.refcount > 0) return
    // Last lease gone — schedule lazy eviction.
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined
      if (entry.refcount > 0 || entry.evicted) return
      this._evictNow(entry)
    }, POOL_GRACE_MS)
  }

  private _evictNow(entry: PoolEntry): void {
    if (entry.evicted) return
    entry.evicted = true
    if (entry.graceTimer !== undefined) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = undefined
    }
    const inflight = this._pool.get(entry.key)
    if (inflight) {
      // Only drop our own entry if it's still the one mapped to the key.
      void inflight.then(
        (e) => {
          if (e === entry && this._pool.get(entry.key) === inflight) {
            this._pool.delete(entry.key)
          }
        },
        () => {
          // creation failure — already self-deleted.
        },
      )
    }
    void this._host.stop(entry.handle).catch(() => {
      // best-effort
    })
    this._liveHandles.delete(entry.handle)
    this._entriesStore.delete(entry.entryStore)
    try {
      entry.stderr.dispose()
    } catch {
      // OutputChannel.dispose is idempotent.
    }
    entry.tracer.dispose()
    if (entry.terminalsBySession.size > 0) {
      for (const ids of entry.terminalsBySession.values()) {
        for (const id of ids) {
          void this._terminals.release(id).catch(() => {
            // best-effort
          })
        }
      }
      entry.terminalsBySession.clear()
    }
  }

  private _reportBlockedPath(
    op: 'read' | 'write' | 'terminal-cwd',
    path: string,
    reason: string,
  ): void {
    this._logger.warn(`blocked agent fs/${op}: ${path} (${reason})`)
    this._telemetry.publicLog('acp.path_blocked', { op, reason })
    this._notification.notify({
      severity: Severity.Warning,
      message: `Agent's request to ${op} "${path}" was blocked: ${reason}`,
    })
  }
}

function bucketFor(map: Map<string, Set<string>>, sessionId: string): Set<string> {
  let s = map.get(sessionId)
  if (!s) {
    s = new Set<string>()
    map.set(sessionId, s)
  }
  return s
}

function assertTerminalOwned(
  map: Map<string, Set<string>>,
  sessionId: string,
  terminalId: string,
): void {
  const bucket = map.get(sessionId)
  if (!bucket || !bucket.has(terminalId)) {
    throw RequestError.invalidParams(undefined, `Unknown terminal: ${terminalId}`)
  }
}

function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content
  const lines = content.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
