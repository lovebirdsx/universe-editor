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
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { AcpAuthGuidanceService } from '../acpAuthGuidanceService.js'
import { AcpSessionFactory } from '../acpSessionFactory.js'
import { __setRecoveryBackoffForTests, MAX_RECOVERY_ATTEMPTS } from '../acpSessionRecovery.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'

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
    /** Ordered RPC log ('prompt' / `config:<id>`) for cross-RPC ordering assertions. */
    events: string[]
  }> = []

  constructor(private readonly _script: Script) {}

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }
  drainAll(): void {}
  killConnectionFor(): void {}

  /** Emit a session/update to the given (1-based) connection's sink. */
  emit(connIndex: number, update: Record<string, unknown>): void {
    const c = this.connections[connIndex]!
    this._sink!.onSessionUpdate({ sessionId: c.agentSessionId, update } as never)
  }

  /** Abort the given connection's signal — simulates the agent process dying. */
  killConnection(connIndex: number): void {
    this.connections[connIndex]!.controller.abort()
  }

  async connect(): Promise<IAcpClientConnection> {
    if (!this._sink) throw new Error('sink not installed')
    const agentSessionId = 'agent-durable' // stable durable id across reconnects
    const controller = new AbortController()
    const promptCalls: PromptRequest[] = []
    const configCalls: SetSessionConfigOptionRequest[] = []
    const events: string[] = []
    this.connections.push({ agentSessionId, controller, promptCalls, configCalls, events })
    const isFirst = this._seq === 0
    this._seq++
    const bag = this._script.configOptions
    const sessionResponse = {
      sessionId: agentSessionId,
      ...(bag ? { configOptions: bag } : {}),
    }
    const conn = {
      signal: controller.signal,
      prompt: (req: PromptRequest): Promise<PromptResponse> => {
        promptCalls.push(req)
        events.push('prompt')
        const next = this._script.promptResults.shift()
        if (!next) return Promise.resolve({ stopReason: 'end_turn' } as PromptResponse)
        return next(req)
      },
      cancel: () => Promise.resolve(),
      newSession: () => Promise.resolve(sessionResponse),
      loadSession: () => Promise.resolve({}),
      resumeSession: () => Promise.resolve(sessionResponse),
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
    }
    const initializeResult = Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: this._script.loadSession, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
    return {
      conn: conn as never,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {},
      // Expose which connect this was for assertions.
      _isFirst: isFirst,
    } as unknown as IAcpClientConnection
  }
}

function makeService(client: IAcpClientService, config: ConfigurationService): AcpSessionService {
  const notification = new StubNotificationService()
  const telemetry = new NoopTelemetryService() as ITelemetryService
  const history = new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_URI_IDENTITY,
  )
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
    expect(client.connections[0]!.promptCalls[0]!.messageId).toBe(
      client.connections[0]!.promptCalls[1]!.messageId,
    )
    // No [error] on the timeline for a recovered turn.
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
})
