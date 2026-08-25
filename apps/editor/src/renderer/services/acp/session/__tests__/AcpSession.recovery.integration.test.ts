/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-recovery integration tests: transient turn retry (Tier 1) and hot
 *  reconnect after process death (Tier 2). Drives the real AcpSessionService +
 *  AcpSession through a controllable in-memory client so we exercise the actual
 *  routing / recovery loops without the SDK wire.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
  UriIdentityService,
} from '@universe-editor/platform'
import type {
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IStorageService,
  IWorkspace,
  IWorkspaceService,
  ITelemetryService,
} from '@universe-editor/platform'
import type {
  InitializeResponse,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import { AcpSession, CONTINUE_PROMPT_TEXT, recoveryContinuePromptText } from '../acpSession.js'
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { AcpAuthGuidanceService } from '../acpAuthGuidanceService.js'
import { AcpSessionFactory } from '../acpSessionFactory.js'
import { __setRecoveryBackoffForTests, MAX_RECOVERY_ATTEMPTS } from '../acpSessionRecovery.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubExtensionMcpServersService } from './stubExtensionMcpServers.js'
import { StubMcpServerEnablementService } from './stubMcpServerEnablement.js'
import { StubFileService } from './stubFileService.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../../acpClientService.js'
import type { IAcpAgentRegistry } from '../../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../../acpPermissionHandler.js'
import type { IAcpModelCandidateService } from '../../acpModelCandidateService.js'
import { stubEnvSnapshotService } from './stubEnvSnapshotService.js'
import { stubAcpModelCandidateService } from './stubAcpModelCandidateService.js'
import { stubWindowsService } from './stubWindowsService.js'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake Agent', command: '/x', args: [] }]
  }
  allAgentIds(): readonly string[] {
    return []
  }
  get(agentId: string) {
    if (agentId === 'fake') return this.list()[0]!
    throw new Error(`unknown agent ${agentId}`)
  }
  resolve(agentId: string) {
    return { command: this.get(agentId).command, args: this.get(agentId).args }
  }
  defaultAgentId(): string {
    return 'fake'
  }
  readonly defaultAgentIdObs = observableValue<string>('fake.defaultAgentId', 'fake')
  setDefaultAgentId(): void {}
  async health(): Promise<{ available: boolean }> {
    return { available: true }
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly current: IWorkspace | null = null
  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly recent: readonly never[] = []
  private readonly _onDidChangeRecent = new Emitter<readonly never[]>()
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  readonly whenReady: Promise<void> = Promise.resolve()
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue<
    readonly INotification[]
  >('stub.notifications', [])
  readonly unreadCount: IObservable<number> = observableValue<number>('stub.unread', 0)
  readonly centerVisible: IObservable<boolean> = observableValue<boolean>('stub.center', false)
  notify(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  prompt(): Promise<void> {
    return Promise.resolve()
  }
  status(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  dismiss(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
  cancelProgress(): void {}
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

class StubPermissionHandler implements IAcpPermissionHandler {
  declare readonly _serviceBrand: undefined
  tryAutoApprove(): RequestPermissionResponse | undefined {
    return undefined
  }
  persistAllow(): void {}
}

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

/**
 * A minimal fake connection whose `prompt` behaviour is scripted per test, and
 * whose `signal` we can abort to simulate process death. One agent process per
 * connect (agent id monotonically increments), mirroring the real pool dropping
 * the dead entry and spawning fresh on the next connect().
 */
interface Script {
  /** prompt() outcomes, consumed in order; a function receives the request. */
  promptResults: Array<(req: PromptRequest) => Promise<PromptResponse>>
  /** capabilities advertised by initialize (loadSession gates reconnect). */
  loadSession: boolean
  /**
   * configOptions bag the agent reports from newSession/resumeSession. Omit to
   * report no bag (agent without config options).
   */
  configOptions?: SessionConfigOption[]
  /** When set, newSession rejects with this error — simulates a startup failure. */
  newSessionError?: Error
  /**
   * When set, resumeSession rejects with this error on every attempt —
   * simulates an agent that has no transcript for the durable id (the fork
   * answers `resourceNotFound` for a session that was never messaged).
   */
  resumeSessionError?: Error
  /**
   * When true, every connect's `newSession` mints a fresh durable id
   * (`agent-durable-1`, `-2`, …) instead of the stable `agent-durable`.
   * Mirrors a real agent: a rebuilt session is a NEW session on its side.
   */
  freshSessionIdPerConnect?: boolean
  /**
   * 1-based connect index whose `attachSession` throws once — simulates the
   * attach failing right after a rebuild moved the history row onto the new
   * durable id, so the retry has to look the row up under the NEW key.
   */
  attachSessionErrorOnConnect?: number
  /**
   * 1-based connect index whose connection is already aborted by the time
   * `connect()` returns — the pool handed out a lease whose process had just
   * died. `attachConnection` sees `signal.aborted` on arrival, which is a
   * startup failure, not an idle reclaim.
   */
  abortOnConnect?: number
}

class ScriptedClient implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  private _sink: IAcpClientNotificationSink | undefined
  private _seq = 0
  readonly connections: Array<{
    agentSessionId: string
    controller: AbortController
    promptCalls: PromptRequest[]
    configCalls: SetSessionConfigOptionRequest[]
    resumeCalls: ResumeSessionRequest[]
    loadCalls: LoadSessionRequest[]
    newCalls: NewSessionRequest[]
    extCalls: Array<{ method: string; params: Record<string, unknown> }>
    /** Ordered RPC log ('prompt' / `config:<id>`) for cross-RPC ordering assertions. */
    events: string[]
  }> = []
  /** Recorded killConnectionFor invocations — the restart path's pool eviction. */
  readonly killCalls: Array<{
    agentId: string
    cwd: string | undefined
    authority: string | undefined
  }> = []

  constructor(readonly script: Script) {}

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }
  drainAll(): void {}
  killConnectionFor(agentId: string, cwd: string | undefined, authority?: string): void {
    this.killCalls.push({ agentId, cwd, authority })
  }

  /** Emit a session/update to the given (1-based) connection's sink. */
  emit(connIndex: number, update: Record<string, unknown>): void {
    const c = this.connections[connIndex]!
    this._sink!.onSessionUpdate({ sessionId: c.agentSessionId, update } as never)
  }

  /** Abort the given connection's signal — simulates the agent process dying. */
  killConnection(connIndex: number): void {
    this.connections[connIndex]!.controller.abort()
  }

  /** Drive an inbound elicitation through the sink (routes by params.sessionId). */
  createElicitation(params: Record<string, unknown>): Promise<unknown> {
    return this._sink!.onCreateElicitation(params as never)
  }

  /** Drive an inbound permission request through the sink. */
  requestPermission(params: Record<string, unknown>): Promise<unknown> {
    return this._sink!.onRequestPermission(params as never)
  }

  async connect(): Promise<IAcpClientConnection> {
    if (!this._sink) throw new Error('sink not installed')
    // Stable durable id across reconnects, unless the script asks each connect
    // to mint a fresh one (what a real agent does for a rebuilt session).
    const agentSessionId = this.script.freshSessionIdPerConnect
      ? `agent-durable-${this._seq + 1}`
      : 'agent-durable'
    const controller = new AbortController()
    const promptCalls: PromptRequest[] = []
    const configCalls: SetSessionConfigOptionRequest[] = []
    const resumeCalls: ResumeSessionRequest[] = []
    const loadCalls: LoadSessionRequest[] = []
    const newCalls: NewSessionRequest[] = []
    const extCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const events: string[] = []
    this.connections.push({
      agentSessionId,
      controller,
      promptCalls,
      configCalls,
      resumeCalls,
      loadCalls,
      newCalls,
      extCalls,
      events,
    })
    const isFirst = this._seq === 0
    this._seq++
    const connectIndex = this._seq
    const bag = this.script.configOptions
    const sessionResponse = {
      sessionId: agentSessionId,
      ...(bag ? { configOptions: bag } : {}),
    }
    const conn = {
      signal: controller.signal,
      prompt: (req: PromptRequest): Promise<PromptResponse> => {
        promptCalls.push(req)
        events.push('prompt')
        const next = this.script.promptResults.shift()
        if (!next) return Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)
        return next(req)
      },
      cancel: () => Promise.resolve(),
      newSession: (req: NewSessionRequest) => {
        newCalls.push(req)
        return this.script.newSessionError
          ? Promise.reject(this.script.newSessionError)
          : Promise.resolve(sessionResponse)
      },
      loadSession: (req: LoadSessionRequest) => {
        loadCalls.push(req)
        return Promise.resolve({})
      },
      resumeSession: (req: ResumeSessionRequest) => {
        resumeCalls.push(req)
        if (this.script.resumeSessionError) {
          return Promise.reject(this.script.resumeSessionError)
        }
        return Promise.resolve(sessionResponse)
      },
      // Apply the pushed value into the returned bag, like a real agent whose
      // session adopted the selection.
      setSessionConfigOption: (req: SetSessionConfigOptionRequest) => {
        configCalls.push(req)
        events.push(`config:${req.configId}`)
        const updated = (bag ?? []).map((o) =>
          o.id === req.configId && o.type === 'select' ? { ...o, currentValue: req.value } : o,
        )
        return Promise.resolve({ configOptions: updated })
      },
      // Custom ext-methods (title push-back, rewind) — recorded per connection.
      extMethod: (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        extCalls.push({ method, params })
        events.push(`ext:${method}`)
        return Promise.resolve({})
      },
    }
    const initializeResult = Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: this.script.loadSession, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
    if (this.script.abortOnConnect === connectIndex) controller.abort()
    return {
      conn: conn as never,
      initializeResult,
      attachSession: (): void => {
        if (this.script.attachSessionErrorOnConnect === connectIndex) {
          // One-shot: the retry's connect must get a working attach.
          delete this.script.attachSessionErrorOnConnect
          throw new Error('attach failed')
        }
      },
      dispose: (): void => {},
      // Expose which connect this was for assertions.
      _isFirst: isFirst,
    } as unknown as IAcpClientConnection
  }
}

function makeHistory(): AcpSessionHistoryService {
  return new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_URI_IDENTITY,
  )
}

function makeService(
  client: IAcpClientService,
  config: ConfigurationService,
  candidates: IAcpModelCandidateService = stubAcpModelCandidateService(),
  history: AcpSessionHistoryService = makeHistory(),
): AcpSessionService {
  const notification = new StubNotificationService()
  const telemetry = new NoopTelemetryService() as ITelemetryService
  const agentDefaults = new AcpAgentDefaultsService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return new AcpSessionService(
    client,
    new FakeAgentRegistry(),
    new FakeWorkspaceService(),
    config,
    notification,
    telemetry,
    new StubPermissionHandler(),
    new StubLoggerService(),
    history,
    new FakeStorage(),
    agentDefaults,
    new StubConfigOptionsCache(),
    FAKE_URI_IDENTITY,
    new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
    new AcpSessionFactory(
      telemetry,
      history,
      agentDefaults,
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      new AcpCompactionStatsService(
        new FakeStorage(),
        new NoopTelemetryService(),
        new StubLoggerService(),
      ),
    ),
    new StubFileService(),
    new StubExtensionMcpServersService(),
    new StubMcpServerEnablementService(),
    stubWindowsService(),
    stubEnvSnapshotService(),
    candidates,
  )
}

function transientError(): Error {
  return Object.assign(new Error('overloaded'), { data: { errorKind: 'overloaded' } })
}

/** Poll an observable until the predicate holds (or time out). */
async function waitFor<T>(
  obs: { get(): T },
  pred: (v: T) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred(obs.get())) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out; last value = ${JSON.stringify(obs.get())}`)
    }
    await new Promise((r) => setTimeout(r, 2))
  }
}

describe('AcpSession auto-recovery', () => {
  let svc: AcpSessionService
  let client: ScriptedClient

  beforeEach(() => {
    // Near-zero backoff so retry/reconnect loops complete fast under real timers.
    __setRecoveryBackoffForTests(() => 1)
  })

  afterEach(() => {
    __setRecoveryBackoffForTests(undefined)
    svc.dispose()
    vi.useRealTimers()
  })

  it('retries a transient turn failure and clears recovery on success', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First attempt fails transiently, second succeeds.
        () => Promise.reject(transientError()),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    // A retry episode surfaces, then clears once the second attempt lands.
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections[0]!.promptCalls.length).toBe(2)
    // No duplicate user message: both attempts reuse the same messageId (zero output).
    expect(client.connections[0]!.promptCalls[0]!._meta?.messageId).toBe(
      client.connections[0]!.promptCalls[1]!._meta?.messageId,
    )
    // No [error] on the timeline for a recovered turn.
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(false)
  })

  it('retries an unknown-kind turn failure whose message text is transient', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // The proxy/gateway-mangled response the claude fork reports with
        // errorKind 'unknown' — only the message text marks it transient.
        () =>
          Promise.reject(
            Object.assign(
              new Error(
                'Internal error: API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request',
              ),
              { code: -32603, data: { errorKind: 'unknown' } },
            ),
          ),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections[0]!.promptCalls.length).toBe(2)
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(false)
  })

  it('surfaces exhausted state after retries run out, keeping a manual retry', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => Promise.reject(transientError()),
        () => Promise.reject(transientError()),
        () => Promise.reject(transientError()),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    expect(s.status.get()).toBe('errored')
    expect(client.connections[0]!.promptCalls.length).toBe(MAX_RECOVERY_ATTEMPTS)
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(true)
  })

  it('hot-reconnects after an agent-internal crash error and resumes the turn', async () => {
    // The ACP SDK wraps a bare exception thrown inside the agent process as
    // internalError({ details }) — the connection stays alive, so neither the
    // close listener nor the stall watchdog ever fires. The prompt failure
    // itself must start the reconnect tier.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () =>
          Promise.reject(
            Object.assign(
              new Error("Internal error: undefined is not an object (evaluating 'e.includes')"),
              {
                code: -32603,
                data: { details: "undefined is not an object (evaluating 'e.includes')" },
              },
            ),
          ),
        // After reconnect, the resumed turn succeeds.
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    // The crash diverts to the reconnect tier: a fresh spawn + session/resume,
    // then the zero-output turn is resent verbatim on the new connection.
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections.length).toBe(2)
    expect(client.connections[0]!.promptCalls.length).toBe(1)
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    expect(client.connections[1]!.promptCalls[0]!._meta?.messageId).toBe(
      client.connections[0]!.promptCalls[0]!._meta?.messageId,
    )
    // The crash message stays on the timeline for context, but the session
    // recovered instead of sealing to `errored`.
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(true)
    expect(s.status.get()).toBe('idle')
  })

  it('hot-reconnects after the process dies and resumes a zero-output turn', async () => {
    let resolveFirst: (() => void) | undefined
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First turn hangs until the connection is killed (never resolves).
        () => new Promise<PromptResponse>(() => {}),
        // After reconnect, the resumed turn succeeds.
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveFirst = () => resolve({ stopReason: 'end_turn' } as PromptResponse)
          }),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('run something')
    await waitFor(s.status, (v) => v === 'running')

    // Process dies mid-turn.
    client.killConnection(0)
    // Session enters reconnecting, then the service re-handshakes on a new connect.
    await waitFor(s.recoveryState, (v) => v?.phase === 'reconnecting')
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)
    // The interrupted (zero-output) turn is resent on the fresh connection.
    await waitFor(s.status, (v) => v === 'running')
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    resolveFirst?.()
    await waitFor(s.status, (v) => v === 'idle')
    // A zero-output resend never appends the continuation bubble.
    expect(s.messages.get().some((m) => m.role === 'user' && m.text === '继续')).toBe(false)
  })

  it('resends the original prompt after reconnect when only metadata updates arrived', async () => {
    // Regression: the reconnect handshake always echoes metadata updates
    // (available_commands / current_mode / usage) before the interrupted turn
    // resumes. Those must not flip a zero-output turn onto the '继续' path —
    // the agent never answered, so the original prompt is resent verbatim.
    let resolveResent: (() => void) | undefined
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First turn: a metadata update lands, then the call hangs until killed.
        () => {
          client.emit(0, { sessionUpdate: 'usage_update', used: 0, size: 300000 })
          return new Promise<PromptResponse>(() => {})
        },
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveResent = () => resolve({ stopReason: 'end_turn' } as PromptResponse)
          }),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('run something')
    await waitFor(s.status, (v) => v === 'running')

    client.killConnection(0)
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)
    await waitFor({ get: () => client.connections[1]?.promptCalls.length ?? 0 }, (n) => n === 1)
    const sent = client.connections[1]!.promptCalls[0]!
    expect(sent.prompt.some((b) => b.type === 'text' && b.text === 'run something')).toBe(true)
    expect(s.messages.get().some((m) => m.role === 'user' && m.text === CONTINUE_PROMPT_TEXT)).toBe(
      false,
    )
    resolveResent?.()
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('resumes an interrupted turn with a re-ask hint when a pending elicitation was cancelled by the disconnect', async () => {
    // Plan-mode AskUserQuestion scenario: the question card is up when the
    // process dies. The card settles as cancelled on disconnect, so a bare
    // '继续' would read as "the user skipped the question" — the continuation
    // must tell the agent the question was aborted and should be re-asked.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First turn hangs until the connection is killed (never resolves).
        () => new Promise<PromptResponse>(() => {}),
        // The continuation turn after reconnect succeeds.
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('plan it')
    await waitFor(s.status, (v) => v === 'running')

    // The AskUserQuestion tool_call lands before the elicitation request.
    client.emit(0, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'AskUserQuestion',
      kind: 'other',
      status: 'in_progress',
      content: [],
      locations: [],
    })
    const elicitationPromise = client.createElicitation({
      sessionId: 'agent-durable',
      mode: 'form',
      message: 'Pick one',
      requestedSchema: { type: 'object', properties: { q: { type: 'string' } } },
    })
    await waitFor(s.pendingElicitation, (v) => v !== undefined)

    // Process dies while the question card is up: the card settles as cancelled.
    client.killConnection(0)
    await expect(elicitationPromise).resolves.toMatchObject({ action: 'cancel' })
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)

    // The continuation prompt is the re-ask hint, not a bare '继续'.
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    const sent = client.connections[1]!.promptCalls[0]!
    expect(
      sent.prompt.some((b) => b.type === 'text' && b.text === recoveryContinuePromptText()),
    ).toBe(true)
    // What went on the wire is also what the user sees on the timeline.
    expect(
      s.messages.get().some((m) => m.role === 'user' && m.text === recoveryContinuePromptText()),
    ).toBe(true)
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('resumes an interrupted turn with a re-ask hint when a pending permission was cancelled by the disconnect', async () => {
    // Same as the elicitation case but for the ExitPlanMode permission card.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => new Promise<PromptResponse>(() => {}),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('plan it')
    await waitFor(s.status, (v) => v === 'running')

    client.emit(0, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'ExitPlanMode',
      kind: 'switch_mode',
      status: 'in_progress',
      content: [],
      locations: [],
    })
    const permissionPromise = client.requestPermission({
      sessionId: 'agent-durable',
      toolCall: {
        toolCallId: 'call-1',
        title: 'ExitPlanMode',
        kind: 'switch_mode',
        status: 'in_progress',
        content: [],
        locations: [],
      },
      options: [{ optionId: 'default', kind: 'allow_once', name: 'Yes' }],
    })
    await waitFor(s.pendingPermission, (v) => v !== undefined)

    client.killConnection(0)
    await expect(permissionPromise).resolves.toMatchObject({ outcome: { outcome: 'cancelled' } })
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    const sent = client.connections[1]!.promptCalls[0]!
    expect(
      sent.prompt.some((b) => b.type === 'text' && b.text === recoveryContinuePromptText()),
    ).toBe(true)
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('still sends a bare continuation when the interrupted turn had no pending interaction', async () => {
    // Partial output but nothing awaiting the user — the classic '继续' keeps
    // the agent transcript free of a duplicate user prompt.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => new Promise<PromptResponse>(() => {}),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('run something')
    await waitFor(s.status, (v) => v === 'running')
    client.emit(0, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'working…' },
    })

    client.killConnection(0)
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    const sent = client.connections[1]!.promptCalls[0]!
    expect(sent.prompt.some((b) => b.type === 'text' && b.text === CONTINUE_PROMPT_TEXT)).toBe(true)
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('re-asserts the session config (bypass mode) on the rebuilt agent after hot-reconnect', async () => {
    // The agent rebuilds its session from settings.json on session/resume, so
    // the bag it reports after a hot-reconnect has the mode back at its server
    // default even though the user switched to bypass mid-session.
    const modeOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Always Ask' },
        { value: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    } as SessionConfigOption
    client = new ScriptedClient({
      loadSession: true,
      configOptions: [modeOption],
      promptResults: [
        // First turn hangs until the connection is killed (never resolves).
        () => new Promise<PromptResponse>(() => {}),
        // The continuation turn after reconnect succeeds.
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    // The user switches to bypass at runtime; the selection lands in history.
    await s.setConfigOption('mode', 'bypassPermissions')

    void s.sendPrompt('run something')
    await waitFor(s.status, (v) => v === 'running')

    // Process dies mid-turn; the service hot-reconnects on a fresh connection.
    client.killConnection(0)
    await waitFor(s.recoveryState, (v) => v?.phase === 'reconnecting')
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(client.connections.length).toBe(2)

    // The rebuilt agent must be told the session's saved mode — otherwise it
    // runs the resumed turn under the reset default and starts asking for
    // permission again.
    expect(client.connections[1]!.configCalls.map((c) => `${c.configId}=${c.value}`)).toContain(
      'mode=bypassPermissions',
    )
    // The UI keeps showing the user's selection, not the rebuilt bag's default.
    const mode = s.configOptions.get().find((o) => o.id === 'mode')
    expect(mode?.type === 'select' && mode.currentValue).toBe('bypassPermissions')
    // The re-asserted mode must land BEFORE the resumed turn dispatches, or the
    // continuation prompt runs under the reset default config.
    await waitFor({ get: () => client.connections[1]!.promptCalls.length }, (n) => n === 1)
    const events = client.connections[1]!.events
    expect(events.indexOf('config:mode')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('prompt')).toBeGreaterThan(events.indexOf('config:mode'))
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('re-handshakes on demand when the connection died while the session sat idle', async () => {
    // The agent process exits with nothing in flight: the close path seals
    // the session silently (status 'closed', no recovery state, no [error]).
    // The next user prompt must drive the re-handshake instead of dying on
    // the aborted connection with "ACP connection closed".
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.recoveryState.get()).toBeUndefined()

    await s.sendPrompt('follow up')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    // Fresh spawn + session/resume, then the queued prompt dispatched on the
    // new connection — untouched by the dead one.
    expect(client.connections.length).toBe(2)
    expect(client.connections[0]!.promptCalls.length).toBe(0)
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    const sent = client.connections[1]!.promptCalls[0]!
    expect(sent.prompt.some((b) => b.type === 'text' && b.text.includes('follow up'))).toBe(true)
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(false)
  })

  it('surfaces an error when the idle-dead agent cannot resume the session', async () => {
    client = new ScriptedClient({
      loadSession: false,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    // The session must carry a transcript for resume to be the only option — an
    // empty one is rebuilt with session/new instead of sealing.
    await s.sendPrompt('first')

    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')

    await s.sendPrompt('follow up')
    // Without session/resume support every reconnect attempt fails; the
    // session seals to errored with a manual-retry affordance.
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    expect(s.status.get()).toBe('errored')
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(true)
    // The follow-up was never dispatched: the first connection only ever saw
    // the pre-death prompt, and no later connection got anything.
    expect(client.connections[0]!.promptCalls).toHaveLength(1)
    for (const c of client.connections.slice(1)) expect(c.promptCalls.length).toBe(0)
  })

  it('re-enters reconnect when the user prompts again after recovery exhaustion', async () => {
    client = new ScriptedClient({
      loadSession: false,
      promptResults: [
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    // Same as above: a transcript is what makes resume the only path.
    await s.sendPrompt('seed')

    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    await s.sendPrompt('first attempt')
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    const connsAfterExhausted = client.connections.length

    // The agent is fixed so it now supports resume; the user's next prompt
    // drives a fresh reconnect round instead of being swallowed silently.
    client.script.loadSession = true
    await s.sendPrompt('second attempt')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections.length).toBe(connsAfterExhausted + 1)
    const last = client.connections[client.connections.length - 1]!
    expect(last.promptCalls.length).toBe(1)
    expect(
      last.promptCalls[0]!.prompt.some(
        (b) => b.type === 'text' && b.text.includes('second attempt'),
      ),
    ).toBe(true)
  })

  it('hot-reconnects a manual retry when the connection died after retries exhausted', async () => {
    // Transient retries run out (connection alive, _failedPrompt kept), then
    // the process dies while the session sits in the exhausted state. The
    // recovery bar's Retry must hot-reconnect and re-dispatch the failed
    // prompt on the fresh connection — not fire it into the dead one.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => Promise.reject(transientError()),
        () => Promise.reject(transientError()),
        () => Promise.reject(transientError()),
        // After the reconnect, the resent turn succeeds.
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    const failedMessageId = client.connections[0]!.promptCalls[0]!._meta?.messageId

    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')

    await s.retryRecovery()
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections.length).toBe(2)
    // The zero-output turn is resent verbatim (same messageId) on the new connection.
    expect(client.connections[1]!.promptCalls.length).toBe(1)
    expect(client.connections[1]!.promptCalls[0]!._meta?.messageId).toBe(failedMessageId)
    // Only the original exhaustion [error] is on the timeline — the retry
    // itself recovered silently.
    expect(s.messages.get().filter((m) => m.text.startsWith('[error]')).length).toBe(1)
  })

  it('does not reconnect after a user-initiated close', async () => {
    client = new ScriptedClient({ loadSession: true, promptResults: [] })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.close()
    await s.sendPrompt('too late')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.connections.length).toBe(1)
  })

  it('queues prompts sent while a reconnect is already in flight', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    void s.sendPrompt('one')
    void s.sendPrompt('two')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    // A single reconnect round; both prompts flush on the fresh connection.
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.promptCalls.length).toBe(2)
  })

  it('does not reconnect a session that failed during startup (no durable id)', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [],
      newSessionError: new Error('spawn failed'),
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await waitFor(s.status, (v) => v === 'errored')

    await s.sendPrompt('hello')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.connections.length).toBe(1)
  })

  it('marks the automatic continuation message autoRetry on a transient retry with partial output', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First attempt streams partial output, then fails transiently.
        () => {
          client.emit(0, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial' },
          })
          return Promise.reject(transientError())
        },
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')

    // The recovery machinery appended one continuation bubble, stamped autoRetry;
    // the user's own message is untouched.
    const continuation = s.messages.get().find((m) => m.role === 'user' && m.text === '继续')
    expect(continuation).toMatchObject({ autoRetry: true })
    const original = s.messages.get().find((m) => m.role === 'user' && m.text === 'do it')
    expect(original?.autoRetry).toBeUndefined()
    // The wire retry carried the continuation text, not the original prompt.
    const second = client.connections[0]!.promptCalls[1]!
    expect(second.prompt.some((b) => b.type === 'text' && b.text === '继续')).toBe(true)
  })

  it('retries with the original prompt when only metadata arrived before a transient failure', async () => {
    // Same guard on the in-place retry path: usage/config echoes during the
    // failed attempt must not switch the resend to a '继续' continuation.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => {
          client.emit(0, { sessionUpdate: 'usage_update', used: 0, size: 300000 })
          return Promise.reject(transientError())
        },
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')

    const second = client.connections[0]!.promptCalls[1]!
    expect(second.prompt.some((b) => b.type === 'text' && b.text === 'do it')).toBe(true)
    expect(s.messages.get().some((m) => m.role === 'user' && m.text === CONTINUE_PROMPT_TEXT)).toBe(
      false,
    )
  })

  it('merges the restarted compaction into the orphan slot after a hot-reconnect', async () => {
    let resolveSecond: ((r: PromptResponse) => void) | undefined
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        // First turn hangs until the connection is killed (never resolves).
        () => new Promise<PromptResponse>(() => {}),
        // The continuation turn stays open until the test resolves it, so the
        // restarted compaction lands while the turn is still in flight.
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveSecond = resolve
          }),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    void s.sendPrompt('run something')
    await waitFor(s.status, (v) => v === 'running')
    // Partial output before the death, so the continuation path is taken.
    client.emit(0, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'partial' },
    })
    // Compaction starts; its settle is lost when the process dies.
    svc.onExtNotification('_universe/compaction', {
      sessionId: s.id,
      id: 'cmp-a',
      phase: 'start',
    })

    client.killConnection(0)
    await waitFor(s.recoveryState, (v) => v?.phase === 'reconnecting')
    await waitFor(s.recoveryState, (v) => v === undefined)
    await waitFor({ get: () => client.connections[1]?.promptCalls.length ?? 0 }, (n) => n === 1)

    // The continuation prompt went out on the fresh connection, stamped autoRetry.
    expect(
      client.connections[1]!.promptCalls[0]!.prompt.some(
        (b) => b.type === 'text' && b.text === '继续',
      ),
    ).toBe(true)
    const continuation = s.messages.get().find((m) => m.role === 'user' && m.text === '继续')
    expect(continuation).toMatchObject({ autoRetry: true })
    // The orphan card is still running (not settled) — the merge target.
    expect(
      s.timeline
        .get()
        .filter((it) => it.kind === 'compaction' && it.compaction.phase === 'running'),
    ).toHaveLength(1)

    // The rebuilt agent restarts compaction under a fresh id: one card, not two.
    svc.onExtNotification('_universe/compaction', {
      sessionId: s.id,
      id: 'cmp-b',
      phase: 'start',
    })
    let cards = s.timeline.get().filter((it) => it.kind === 'compaction')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: 'compaction:cmp-b', compaction: { phase: 'running' } })

    svc.onExtNotification('_universe/compaction', {
      sessionId: s.id,
      id: 'cmp-b',
      phase: 'success',
    })
    cards = s.timeline.get().filter((it) => it.kind === 'compaction')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: 'compaction:cmp-b', compaction: { phase: 'success' } })

    resolveSecond?.({ stopReason: 'end_turn' } as PromptResponse)
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('does not append a second continuation bubble when a manual retry re-dispatches the failed one', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => {
          client.emit(0, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial' },
          })
          return Promise.reject(transientError())
        },
        () => Promise.reject(transientError()),
        () => Promise.reject(transientError()),
        // The manual retry lands.
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('do it')
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    const continuations = () =>
      s.messages.get().filter((m) => m.role === 'user' && m.text === '继续')
    expect(continuations()).toHaveLength(1)
    const continueMessageId = continuations()[0]!.messageId

    await s.retryRecovery()
    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    // Re-dispatch only: the timeline still holds exactly one continuation bubble.
    expect(continuations()).toHaveLength(1)
    expect(client.connections[0]!.promptCalls.length).toBe(4)
    expect(client.connections[0]!.promptCalls[3]!._meta?.messageId).toBe(continueMessageId)
  })

  it('restarts the agent process on request: evicts the pooled connection, then resumes with extraModels and resumeModel', async () => {
    // A model bag seeds the history row so the resume _meta also carries the
    // remembered per-session model — assert both keys together to pin the
    // whole reconnect resume payload.
    const modelOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet 4.6' }],
    } as SessionConfigOption
    client = new ScriptedClient({
      loadSession: true,
      configOptions: [modelOption],
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config, stubAcpModelCandidateService({ models: ['kimi-k3[1m]'] }))
    const s = await svc.createSession()
    await s.whenConnected()
    // A messaged session has an agent-side transcript, so the restart resumes
    // against the same durable id (the empty-session case rebuilds instead —
    // covered by the two tests below).
    await s.sendPrompt('do it')

    s.requestProcessRestart()
    // connect() leases from a refcounted pool keyed by agentId+cwd — without
    // this eviction it would re-lease the same process, so the new spawn env
    // (the whole point of the restart) would never take effect.
    expect(client.killCalls).toEqual([{ agentId: 'fake', cwd: undefined, authority: undefined }])

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections.length).toBe(2)
    const resume = client.connections[1]!.resumeCalls[0]!
    expect(resume.sessionId).toBe('agent-durable')
    const meta = resume._meta as Record<string, unknown>
    expect(meta.extraModels).toEqual(['kimi-k3[1m]'])
    expect((meta.claudeCode as { resumeModel?: string }).resumeModel).toBe('sonnet')
  })

  it('rebuilds an empty session with session/new on restart instead of resuming a transcript it never had', async () => {
    // A session created but never messaged has no agent-side transcript, so
    // `session/resume` answers resourceNotFound — three attempts of it burn the
    // recovery budget and seal the session as "automatic recovery failed",
    // which is exactly what the sub-agent-model restart used to hit.
    const modelOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet 4.6' }],
    } as SessionConfigOption
    client = new ScriptedClient({
      loadSession: true,
      configOptions: [modelOption],
      freshSessionIdPerConnect: true,
      resumeSessionError: new Error('Resource not found: agent-durable-1'),
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    const history = makeHistory()
    svc = makeService(
      client,
      config,
      stubAcpModelCandidateService({ models: ['kimi-k3[1m]'] }),
      history,
    )
    const s = await svc.createSession()
    await s.whenConnected()
    const oldSid = s.sessionIdOnAgent.get()
    expect(oldSid).toBe('agent-durable-1')
    expect(history.get('agent-durable-1')?.hasMessages).toBe(false)

    s.requestProcessRestart()
    expect(client.killCalls).toEqual([{ agentId: 'fake', cwd: undefined, authority: undefined }])

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    // Rebuilt via session/new on the fresh process — never resumed.
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.resumeCalls).toEqual([])
    expect(client.connections[1]!.newCalls).toHaveLength(1)
    const newParams = client.connections[1]!.newCalls[0]!
    expect((newParams._meta as Record<string, unknown>).extraModels).toEqual(['kimi-k3[1m]'])

    // The local session object survives (same local id → same React key, same
    // editor tab, same draft) and now points at the new durable id.
    expect(s.sessionIdOnAgent.get()).toBe('agent-durable-2')
    expect(s.status.get()).toBe('idle')
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(false)

    // The history row moved to the new durable id, keeping its metadata.
    expect(history.get('agent-durable-1')).toBeUndefined()
    const migrated = history.get('agent-durable-2')
    expect(migrated?.hasMessages).toBe(false)
    expect(migrated?.configOptions?.['model']).toBe('sonnet')
    expect(migrated?.title).toBe(s.title)
    // Still exactly one row for this session — no orphan left behind.
    expect(history.list().filter((e) => e.agentId === 'fake')).toHaveLength(1)
  })

  it('keeps a prompt queued during an empty-session restart and dispatches it against the rebuilt id', async () => {
    // The rebuild goes through the same connecting → attach path as a first
    // connect, so a prompt typed mid-restart must land on the NEW durable id
    // rather than being dropped or sent against the dead one.
    client = new ScriptedClient({
      loadSession: true,
      freshSessionIdPerConnect: true,
      resumeSessionError: new Error('Resource not found'),
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    s.requestProcessRestart()
    void s.sendPrompt('typed while restarting')

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    await waitFor({ get: () => client.connections[1]?.promptCalls.length ?? 0 }, (n) => n === 1)
    expect(client.connections[1]!.promptCalls[0]!.sessionId).toBe('agent-durable-2')
    // The dead process never saw it.
    expect(client.connections[0]!.promptCalls).toEqual([])
  })

  it('resumes — never rebuilds — an unmessaged side task, whose transcript the fork already copied', async () => {
    // A side task is the one hasMessages:false session that DOES have an
    // agent-side transcript: forkSideTask copies the parent's whole history
    // before the child sends anything. Rebuilding it with session/new would
    // throw that forked baseline away and leave the side chat without the very
    // context it exists to discuss.
    client = new ScriptedClient({
      loadSession: true,
      freshSessionIdPerConnect: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    const history = makeHistory()
    svc = makeService(client, config, stubAcpModelCandidateService(), history)
    const s = await svc.createSession()
    await s.whenConnected()
    const sid = s.sessionIdOnAgent.get()!
    // Mark the live row like forkSideTask does: empty, but forked off a parent.
    history.add({
      agentId: 'fake',
      sessionIdOnAgent: sid,
      title: 'side task',
      hasMessages: false,
      sideTaskOf: 'parent-durable',
      sideTaskQuote: 'why does this jump?',
    })

    s.requestProcessRestart()

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.resumeCalls[0]?.sessionId).toBe(sid)
    expect(client.connections[1]!.newCalls).toEqual([])
    // The durable id — and therefore the fork parentage — is untouched.
    expect(s.sessionIdOnAgent.get()).toBe(sid)
    expect(history.get(sid)?.sideTaskOf).toBe('parent-durable')
  })

  it('retries a failed rebuild attach against the NEW durable id the history row moved to', async () => {
    // The rebuild re-keys the history row before attaching. If a retry still
    // looked the row up under the dead id it would find nothing, decide the
    // session is not empty after all, and resume against a session the agent
    // no longer has — burning the whole budget on resourceNotFound.
    client = new ScriptedClient({
      loadSession: true,
      freshSessionIdPerConnect: true,
      resumeSessionError: new Error('Resource not found'),
      attachSessionErrorOnConnect: 2,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    const history = makeHistory()
    svc = makeService(client, config, stubAcpModelCandidateService(), history)
    const s = await svc.createSession()
    await s.whenConnected()
    expect(s.sessionIdOnAgent.get()).toBe('agent-durable-1')

    s.requestProcessRestart()

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    // Attempt 1 rebuilt (row → agent-durable-2) but its attach threw; attempt 2
    // must rebuild again rather than resume the dead id.
    expect(client.connections.length).toBe(3)
    expect(client.connections[1]!.newCalls).toHaveLength(1)
    expect(client.connections[2]!.newCalls).toHaveLength(1)
    expect(client.connections[2]!.resumeCalls).toEqual([])
    expect(s.sessionIdOnAgent.get()).toBe('agent-durable-3')
    // Exactly one row survives, on the id the session actually ended up on.
    expect(history.list().filter((e) => e.agentId === 'fake')).toHaveLength(1)
    expect(history.get('agent-durable-3')).toBeDefined()
  })

  it('preserves the restart reason across a second loss so the pool is evicted again', async () => {
    // Two losses in one recovery episode: the second lands after the first
    // reattach cleared the session's latch, so the finally re-run carries the
    // recovery state's reason. A restart degraded to 'crash' there would skip
    // the pool eviction and silently re-lease the old process.
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [
        () => new Promise<PromptResponse>(() => {}),
        () => new Promise<PromptResponse>(() => {}),
        () => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse),
      ],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    const reasons: Array<'crash' | 'stalled' | 'restart' | 'wake'> = []
    // onDidLoseConnection lives on the concrete view-model, not the IAcpSession
    // facade — the harness only ever creates AcpSession instances.
    ;(s as AcpSession).onDidLoseConnection((e) => reasons.push(e.reason))

    void s.sendPrompt('run it')
    await waitFor(s.status, (v) => v === 'running')

    // First loss: user-requested restart. The interrupted turn is resent on
    // the fresh connection and hangs there, keeping the recovery loop in
    // flight while the session's reconnecting latch is already cleared.
    s.requestProcessRestart()
    expect(client.killCalls).toHaveLength(1)
    await waitFor({ get: () => client.connections[1]?.promptCalls.length ?? 0 }, (n) => n === 1)

    // Second loss while the loop is still finishing: swallowed by the dedup,
    // so only the finally re-run (with the carried reason) can recover.
    s.requestProcessRestart()

    await waitFor(s.recoveryState, (v) => v === undefined && s.status.get() === 'idle')
    expect(reasons).toEqual(['restart', 'restart'])
    // The carried reason kept the eviction — degraded to 'crash' the second
    // round would reconnect without killing and this assertion catches it.
    expect(client.killCalls).toHaveLength(2)
    expect(client.connections.length).toBe(3)
    expect(client.connections[2]!.promptCalls.length).toBe(1)
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(false)
  })
})

describe('requestProcessRestart guards', () => {
  function makeBareSession(readOnly = false): AcpSession {
    return new AcpSession(
      'id',
      'fake',
      't',
      new NoopTelemetryService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readOnly,
    )
  }

  it('is a no-op for a closed session', () => {
    const s = makeBareSession()
    s.sessionIdOnAgent.set('sid', undefined)
    s.status.set('closed', undefined)
    const fired = vi.fn()
    s.onDidLoseConnection(fired)

    s.requestProcessRestart()

    expect(fired).not.toHaveBeenCalled()
    expect(s.status.get()).toBe('closed')
    expect(s.isReconnecting).toBe(false)
  })

  it('is a no-op for a read-only session', () => {
    const s = makeBareSession(true)
    s.sessionIdOnAgent.set('sid', undefined)
    s.status.set('idle', undefined)
    const fired = vi.fn()
    s.onDidLoseConnection(fired)

    s.requestProcessRestart()

    expect(fired).not.toHaveBeenCalled()
    expect(s.status.get()).toBe('idle')
    expect(s.isReconnecting).toBe(false)
  })

  it('is a no-op while a reconnect is already in progress', () => {
    const s = makeBareSession()
    s.sessionIdOnAgent.set('sid', undefined)
    s.status.set('running', undefined)
    const fired = vi.fn()
    s.onDidLoseConnection(fired)
    s.handleStall()
    expect(fired).toHaveBeenCalledTimes(1)
    expect(fired.mock.calls[0]![0]).toEqual({ reason: 'stalled' })

    s.requestProcessRestart()

    // The guard swallowed the restart: still only the stall's loss event.
    expect(fired).toHaveBeenCalledTimes(1)
    expect(s.isReconnecting).toBe(true)
  })

  it('is a no-op before the session is attached (no durable id)', () => {
    const s = makeBareSession()
    const fired = vi.fn()
    s.onDidLoseConnection(fired)

    s.requestProcessRestart()

    expect(fired).not.toHaveBeenCalled()
    expect(s.status.get()).toBe('connecting')
    expect(s.isReconnecting).toBe(false)
  })
})

describe('AcpSession dormancy (idle seal + on-demand wake)', () => {
  let svc: AcpSessionService
  let client: ScriptedClient

  beforeEach(() => {
    __setRecoveryBackoffForTests(() => 1)
  })

  afterEach(() => {
    __setRecoveryBackoffForTests(undefined)
    svc.dispose()
    vi.useRealTimers()
  })

  /** A session that settled one prompt — resumable (hasMessages) and idle. */
  async function makeSeededSession(history?: AcpSessionHistoryService) {
    const config = new ConfigurationService()
    svc = history
      ? makeService(client, config, stubAcpModelCandidateService(), history)
      : makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    await s.sendPrompt('seed')
    await waitFor(s.status, (v) => v === 'idle')
    return s
  }

  it('marks an idle-killed session dormant and wakes it on demand via session/resume', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    expect(await s.ensureAwake()).toBe('ready')
    await waitFor(s.recoveryState, (v) => v === undefined)
    expect(s.isDormant.get()).toBe(false)
    expect(s.status.get()).toBe('idle')
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.resumeCalls).toHaveLength(1)
    expect(client.connections[1]!.resumeCalls[0]!.sessionId).toBe('agent-durable')
  })

  it('clears the dormant flag on a user-initiated close so the session can never wake', async () => {
    client = new ScriptedClient({ loadSession: true, promptResults: [] })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    await s.close()
    expect(s.status.get()).toBe('closed')
    expect(s.isDormant.get()).toBe(false)
    // A closed session is terminal: no wake, no spawn, ever.
    expect(await s.ensureAwake()).toBe('closed')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.connections.length).toBe(1)
  })

  it('shares a single reconnect across concurrent ensureAwake callers', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    const [first, second] = await Promise.all([s.ensureAwake(), s.ensureAwake()])
    expect(first).toBe('ready')
    expect(second).toBe('ready')
    // One wake, one spawn — the second caller rode the same re-handshake.
    expect(client.connections.length).toBe(2)
    expect(client.connections[1]!.resumeCalls).toHaveLength(1)
  })

  it('surfaces a failed wake: recovery exhausts and the session seals to errored', async () => {
    client = new ScriptedClient({
      loadSession: true,
      resumeSessionError: new Error('Resource not found'),
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    expect(await s.ensureAwake()).toBe('failed')
    await waitFor(s.recoveryState, (v) => v?.phase === 'exhausted')
    expect(s.status.get()).toBe('errored')
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(true)
  })

  it('does not spawn during the initial handshake when ensureAwake is called', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    // Still connecting: no durable id yet, so _wakeIfDormant must not fire a
    // reconnect — the very first handshake is the wake. ensureAwake currently
    // awaits that handshake too (see the 'connecting' outcome note in the
    // report), so it resolves 'ready' — never a wake failure, never a spawn.
    const outcome = await s.ensureAwake()
    expect(outcome).toBe('ready')
    expect(client.connections.length).toBe(1)
    expect(client.connections[0]!.newCalls).toHaveLength(1)
    await waitFor(s.status, (v) => v === 'idle')
  })

  it('never wakes a read-only preview: no loss event, no spawn, no dormant flag', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    await s.sendPrompt('seed')
    const sid = s.sessionIdOnAgent.get()!
    // Drop the resident instance so the read-only resume builds its own
    // connection (a live session is reused as-is otherwise).
    await svc.closeSession(s.id)
    const ro = await svc.resumeSessionReadOnly(sid)
    await ro.whenConnected()
    const fired = vi.fn()
    ;(ro as AcpSession).onDidLoseConnection(fired)

    client.killConnection(1)
    await waitFor(ro.status, (v) => v === 'closed')
    await new Promise((r) => setTimeout(r, 30))
    expect(fired).not.toHaveBeenCalled()
    expect(client.connections.length).toBe(2)
    expect(ro.isDormant.get()).toBe(false)
  })

  it('counts a wake as activity — lastActivityAt moves past the seal', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    // Distance the seal from the wake so a missing activity bump is detectable:
    // without it, lastActivityAt still points at the pre-death dispatch.
    await new Promise((r) => setTimeout(r, 10))
    const sealedAt = Date.now()
    expect((s as AcpSession).lastActivityAt).toBeLessThan(sealedAt)

    expect(await s.ensureAwake()).toBe('ready')
    expect((s as AcpSession).lastActivityAt).toBeGreaterThanOrEqual(sealedAt)
  })

  it('buffers a manual rename while dormant and replays it to the agent on wake', async () => {
    client = new ScriptedClient({
      loadSession: true,
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const history = makeHistory()
    const s = await makeSeededSession(history)
    const sid = s.sessionIdOnAgent.get()!
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    // The rename lands locally only: the dead lease must not get an RPC, and
    // nothing spawns just to record a title.
    expect(svc.renameSession(s.id, 'Renamed Title')).toBe(true)
    expect(history.get(sid)?.title).toBe('Renamed Title')
    expect(history.get(sid)?.manualTitle).toBe(true)
    expect(client.connections[0]!.extCalls).toEqual([])
    expect(client.connections.length).toBe(1)

    // The wake's attach replays the buffered title onto the fresh connection.
    expect(await s.ensureAwake()).toBe('ready')
    await waitFor({ get: () => client.connections[1]?.extCalls.length ?? 0 }, (n) => n === 1)
    expect(client.connections[1]!.extCalls[0]).toEqual({
      method: 'universe-editor/set_session_title',
      params: { sessionId: sid, title: 'Renamed Title' },
    })
  })

  it('does not flag a startup failure dormant when the pool hands over a dead lease', async () => {
    // The lease is already aborted when attachConnection receives it. Because
    // `open()` has by then flipped the phase to 'connected', a phase-based test
    // cannot tell this from an idle reclaim — so the seal is told explicitly.
    // Getting it wrong shows the user a session that never started wearing the
    // moon glyph and the "asleep to save memory" tooltip, and makes the list row
    // activate in place instead of re-resuming.
    client = new ScriptedClient({ loadSession: true, promptResults: [], abortOnConnect: 1 })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    expect(s.status.get()).toBe('closed')
    expect(s.isDormant.get()).toBe(false)
    // It stays re-handshakeable, though: `session/new` did hand back a durable
    // id, so an explicit action can still rebuild it — the same thing sendPrompt
    // has always done on a dead lease. It never got a message, so the rebuild
    // goes through `session/new` rather than resuming a transcript. Only the
    // "asleep" labelling is withheld.
    expect(await s.ensureAwake()).toBe('ready')
    expect(client.connections).toHaveLength(2)
    expect(client.connections[1]!.newCalls).toHaveLength(1)
  })

  it('lands a config switch on the woken connection when the session was asleep', async () => {
    // setConfigOption on a dead lease used to reject and roll the picked value
    // back. It now wakes first — and the RPC has to arrive on the FRESH
    // connection, not the dead one.
    const modelOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet 4.6' },
        { value: 'opus', name: 'Opus 4.7' },
      ],
    } as SessionConfigOption
    client = new ScriptedClient({
      loadSession: true,
      configOptions: [modelOption],
      promptResults: [() => Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)],
    })
    const s = await makeSeededSession()
    client.killConnection(0)
    await waitFor(s.status, (v) => v === 'closed')
    expect(s.isDormant.get()).toBe(true)

    await s.setConfigOption('model', 'opus')

    expect(client.connections).toHaveLength(2)
    expect(client.connections[0]!.configCalls).toEqual([])
    expect(client.connections[1]!.configCalls).toEqual([
      { sessionId: 'agent-durable', configId: 'model', value: 'opus' },
    ])
    expect(s.configOptions.get()[0]?.currentValue).toBe('opus')
  })

  it('settles prompts queued before a dead-on-arrival attach instead of hanging them', async () => {
    // `open()` drains the queue out of the connection before the aborted lease
    // is noticed, so that branch owns those prompts. Left undrained, the queued
    // promise never settles: sendPrompt swallows the rejection (so PromptInput
    // sees no unhandled rejection) but its own await would hang forever.
    client = new ScriptedClient({ loadSession: true, promptResults: [], abortOnConnect: 1 })
    const config = new ConfigurationService()
    svc = makeService(client, config)
    // Deliberately not awaited: createSession publishes the session
    // synchronously and only then kicks off the handshake, so this is the
    // window where a typed prompt still queues.
    const creating = svc.createSession()
    const s = svc.sessions.get()[0]!
    const queued = s.sendPrompt('typed while connecting').then(() => 'settled' as const)
    const raced = await Promise.race([
      queued,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 200)),
    ])
    expect(raced).toBe('settled')
    await creating
  })
})
