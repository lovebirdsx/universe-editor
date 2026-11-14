/*---------------------------------------------------------------------------------------------
 *  Remote workspace triggers: connection-gated config discovery, the remote run
 *  pipeline (poll / run dir / deferred replay), and remote report reads.
 *--------------------------------------------------------------------------------------------*/

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  Emitter,
  Event,
  RemoteChannels,
  URI,
  type IFileService,
  type ILogger,
  type IOpenWindowInfo,
  type IRemoteEnvironment,
} from '@universe-editor/platform'
import type {
  TriggerPollRequest,
  TriggerPollResult,
  TriggerRunDirectoryOptions,
  TriggerRunReportReadOptions,
  TriggerRunReportReadResult,
} from '@universe-editor/node-services'
import type { ITriggerRunHost } from '../../../../shared/ipc/triggerService.js'
import {
  MAX_TRIGGER_REPORT_BYTES,
  type TriggerConfig,
  type TriggerRunRequest,
  type TriggersConfig,
} from '../../../../shared/triggers/types.js'
import type {
  IRemoteConnection,
  IRemoteConnectionService,
  IRemoteConnectionStateChange,
  RemoteConnectionState,
} from '../../remote/remoteConnectionMainService.js'
import {
  TriggerMainService,
  type TriggerClock,
  type TriggerWindowProvider,
} from '../triggerMainService.js'
import { triggerKeyFor } from '../triggerIdentity.js'
import { workspaceTriggersConfigDirUri, workspaceTriggersConfigUri } from '../triggersConfigFile.js'

const AUTHORITY = 'dev'
const WORKSPACE = URI.from({
  scheme: 'remote-ssh',
  authority: AUTHORITY,
  path: '/home/testuser/proj',
})
const CONFIG_URI = workspaceTriggersConfigUri(WORKSPACE)
const DIR_URI = workspaceTriggersConfigDirUri(WORKSPACE)
const CLIENT_ID = 'client-test'
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'

const BUDGET = { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 }

function remoteRunDir(clientId: string, runId: string): URI {
  return URI.from({
    scheme: 'remote-ssh',
    authority: AUTHORITY,
    path: `/home/testuser/.universe-editor-server/triggers/runs/${clientId}/${runId}`,
  })
}

function pollSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'poll',
    intervalSec: 30,
    fetch: { type: 'command', command: 'gh pr list', timeoutSec: 1 },
    keyField: 'id',
    ...overrides,
  }
}

interface ConfigOverrides {
  readonly source?: unknown
  readonly session?: Record<string, unknown>
}

function configText(id: string, overrides: ConfigOverrides = {}): string {
  const config: TriggersConfig = {
    version: 1,
    triggers: [
      {
        id,
        name: id,
        enabled: true,
        showSession: false,
        source: (overrides.source ?? { type: 'manual' }) as TriggerConfig['source'],
        session: { prompt: 'Do it', budget: BUDGET, ...(overrides.session ?? {}) },
        allowedActions: [],
        concurrency: 1,
        overflow: 'queue',
      },
    ],
    invalid: [],
  }
  return JSON.stringify(config, null, 2)
}

function createLogger(): { logger: ILogger; lines: string[] } {
  const lines: string[] = []
  const logger = {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: (message: string) => lines.push(`trace: ${message}`),
    debug: (message: string) => lines.push(`debug: ${message}`),
    info: (message: string) => lines.push(`info: ${message}`),
    warn: (message: string) => lines.push(`warn: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
    flush: () => undefined,
  } as unknown as ILogger
  return { logger, lines }
}

class FakeFileService {
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>()
  readonly reads: string[] = []
  writes = 0

  async readFileText(uri: URI): Promise<string> {
    this.reads.push(uri.toString())
    const text = this.files.get(uri.toString())
    if (text === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return text
  }

  async exists(uri: URI): Promise<boolean> {
    return this.files.has(uri.toString()) || this.directories.has(uri.toString())
  }

  async writeFile(uri: URI, content: Uint8Array | string): Promise<void> {
    this.writes++
    this.files.set(uri.toString(), typeof content === 'string' ? content : String(content))
  }

  async createDirectory(uri: URI): Promise<void> {
    this.directories.add(uri.toString())
  }
}

class FakeConnections {
  state: RemoteConnectionState | undefined = 'connected'
  channelCalls = 0
  connectionCalls = 0
  readonly proxyChannels: string[] = []
  readonly poll = vi.fn(
    async (_request: TriggerPollRequest): Promise<TriggerPollResult> => ({ ok: true, items: [] }),
  )
  readonly createRunDir = vi.fn(
    async (clientId: string, runId: string, _options: TriggerRunDirectoryOptions) => ({
      runDir: remoteRunDir(clientId, runId),
    }),
  )
  readonly readReport = vi.fn(
    async (
      _clientId: string,
      _runId: string,
      _options?: TriggerRunReportReadOptions,
    ): Promise<TriggerRunReportReadResult> => ({ ok: false, reason: 'not_found' }),
  )

  private readonly _onDidChangeState = new Emitter<IRemoteConnectionStateChange>()
  readonly onDidChangeState = this._onDidChangeState.event

  private readonly _connection: IRemoteConnection = {
    authority: AUTHORITY,
    env: {} as IRemoteEnvironment,
    getChannel: () => ({
      call: async <T>(_command: string): Promise<T> => {
        this.channelCalls++
        return undefined as T
      },
      listen: () => Event.None,
    }),
    onDidClose: Event.None,
  }

  private readonly _service = {
    poll: this.poll,
    createRunDir: this.createRunDir,
    cleanupRuns: async (): Promise<{ removed: readonly string[] }> => ({ removed: [] }),
    readReport: this.readReport,
  }

  getState = (_authority: string): RemoteConnectionState | undefined => this.state

  getConnection = async (_authority: string): Promise<IRemoteConnection> => {
    this.connectionCalls++
    return this._connection
  }

  getServiceProxy = <T extends object>(_authority: string, channelName: string): T => {
    this.proxyChannels.push(channelName)
    return this._service as unknown as T
  }

  setState(state: RemoteConnectionState): void {
    this.state = state
    this._onDidChangeState.fire({ authority: AUTHORITY, state })
  }
}

class FakeClock implements TriggerClock {
  private _now: number
  private _seq = 0
  private readonly _timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start = Date.now()) {
    this._now = start
  }

  now = (): number => this._now

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this._seq
    this._timers.set(id, { at: this._now + Math.max(0, ms), callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this._timers.delete(handle as number)
  }

  async advance(ms: number): Promise<void> {
    const target = this._now + ms
    for (;;) {
      const next = [...this._timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (next === undefined) break
      this._timers.delete(next[0])
      this._now = Math.max(this._now, next[1].at)
      next[1].callback()
      await settle()
    }
    this._now = target
  }
}

interface HarnessOptions {
  readonly state?: RemoteConnectionState
  readonly config?: string | null
  readonly registerWindow?: boolean
  /** Register the host without exposing the window to the window provider. */
  readonly windowVisible?: boolean
  readonly clientId?: string
  readonly remotePollGraceMs?: number
  /** Override the remote poll RPC (default: an empty result). */
  readonly pollImpl?: () => Promise<TriggerPollResult>
}

interface Harness {
  readonly service: TriggerMainService
  readonly clock: FakeClock
  readonly files: FakeFileService
  readonly connections: FakeConnections
  readonly loggerLines: string[]
  readonly startRun: ReturnType<typeof vi.fn>
  readonly requests: TriggerRunRequest[]
  readonly poll: FakeConnections['poll']
  readonly createRunDir: FakeConnections['createRunDir']
  readonly readReport: FakeConnections['readReport']
  readonly proxyChannels: string[]
  readonly openWindow: ReturnType<typeof vi.fn>
  pendingCount(): number
  showWindow(): void
}

const services: TriggerMainService[] = []
const dirs: string[] = []

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Workspace-defined triggers stay dormant until confirmed once on this machine. */
async function confirmAll(service: TriggerMainService): Promise<void> {
  for (const entry of await service.listTriggers()) {
    if (entry.status !== 'invalid') await service.confirmActivation(entry.key)
  }
}

async function discoverAndConfirm(harness: Harness): Promise<void> {
  await waitFor(async () => (await harness.service.listTriggers()).length === 1)
  await confirmAll(harness.service)
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkTempDir('ue-triggers-remote-')
  dirs.push(dir)
  const files = new FakeFileService()
  if (options.config !== null && options.config !== undefined) {
    files.files.set(CONFIG_URI.toString(), options.config)
    files.directories.add(DIR_URI.toString())
  }
  const connections = new FakeConnections()
  connections.state = options.state ?? 'connected'
  if (options.pollImpl !== undefined) connections.poll.mockImplementation(options.pollImpl)
  const { logger, lines } = createLogger()
  const requests: TriggerRunRequest[] = []
  const startRun = vi.fn(async (request: TriggerRunRequest) => {
    requests.push(request)
    return { sessionId: `session-${requests.length}` }
  })
  const host: ITriggerRunHost = {
    _serviceBrand: undefined,
    startRun,
    cancelRun: vi.fn(async () => undefined),
    isWorkspaceTrusted: vi.fn(async () => true),
  }
  const clock = new FakeClock()
  const service = new TriggerMainService({
    userDataDir: dir,
    logger,
    clock,
    startupGraceMs: 0,
    readMaxConcurrentRuns: async () => 2,
    fileService: files as unknown as IFileService,
    remoteConnections: connections as unknown as IRemoteConnectionService,
    clientId: async () => options.clientId ?? CLIENT_ID,
    ...(options.remotePollGraceMs === undefined
      ? {}
      : { remotePollGraceMs: options.remotePollGraceMs }),
  })
  services.push(service)
  const windows: IOpenWindowInfo[] = []
  const openWindow = vi.fn(async (_folder: URI) => undefined)
  const provider: TriggerWindowProvider = {
    getOpenWindowInfos: () => windows,
    openWindowForFolderInBackground: openWindow,
  }
  service.setWindowProvider(provider)
  const showWindow = (): void => {
    if (!windows.some((entry) => entry.id === 1)) {
      windows.push({ id: 1, folder: WORKSPACE.toJSON(), name: 'remote' })
    }
  }
  if (options.registerWindow !== false) {
    if (options.windowVisible !== false) showWindow()
    service.registerWindowHost(1, host, WORKSPACE)
  }
  await service.initialize()
  await settle()
  // Startup grace is 0: fire the gate timer so scheduling / deferred replay runs.
  await clock.advance(0)
  await settle()
  return {
    service,
    clock,
    files,
    connections,
    loggerLines: lines,
    startRun,
    requests,
    poll: connections.poll,
    createRunDir: connections.createRunDir,
    readReport: connections.readReport,
    proxyChannels: connections.proxyChannels,
    openWindow,
    pendingCount: () =>
      (service as unknown as { _state: { pending: readonly unknown[] } })._state.pending.length,
    showWindow: () => {
      showWindow()
      service.registerWindowHost(1, host, WORKSPACE)
    },
  }
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await settle()
  for (const dir of dirs.splice(0)) await rm(join(dir), { recursive: true, force: true })
})

describe('TriggerMainService remote workspaces', () => {
  it('defers discovery while the connection is not connected (no remote I/O)', async () => {
    const harness = await createHarness({ state: 'reconnecting', config: configText('remote-a') })

    expect(await harness.service.listTriggers()).toEqual([])
    expect(harness.files.reads).toEqual([])
    expect(harness.connections.connectionCalls).toBe(0)
    expect(harness.loggerLines.some((line) => line.includes('deferred'))).toBe(true)
  })

  it('discovers and lists a remote workspace once connected', async () => {
    const harness = await createHarness({ config: configText('remote-a') })

    await waitFor(async () => (await harness.service.listTriggers()).length === 1)
    const [summary] = await harness.service.listTriggers()
    expect(summary?.id).toBe('remote-a')
    expect(summary?.workspace).toBe(WORKSPACE.toString())
    expect(summary?.offline).toBe(false)
    expect(summary?.key).toBe(triggerKeyFor(WORKSPACE.toString(), 'remote-a'))
    expect(harness.files.reads).toContain(CONFIG_URI.toString())

    const workspaces = await harness.service.listWorkspaces()
    expect(workspaces.map((entry) => entry.workspace)).toEqual([WORKSPACE.toString()])
    expect(workspaces[0]?.configPath).toBe(CONFIG_URI.toString())
  })

  it('keeps an offline snapshot on disconnect and prevents runs and further I/O', async () => {
    const harness = await createHarness({ config: configText('remote-a') })
    await waitFor(async () => (await harness.service.listTriggers()).length === 1)

    harness.connections.setState('reconnecting')
    await waitFor(async () => (await harness.service.listTriggers())[0]?.offline === true)

    const readsAfterDisconnect = harness.files.reads.length
    const channelCalls = harness.connections.channelCalls
    const [summary] = await harness.service.listTriggers()
    expect(summary?.id).toBe('remote-a')
    expect(summary?.workspace).toBe(WORKSPACE.toString())
    await expect(harness.service.runNow(summary!.key)).rejects.toThrow(/not connected/)

    // Later transitional states must not restart the watcher or re-read the file.
    harness.connections.setState('deploying')
    harness.connections.setState('failed')
    await settle()
    expect(harness.files.reads.length).toBe(readsAfterDisconnect)
    expect(harness.connections.channelCalls).toBe(channelCalls)
    expect(harness.startRun).not.toHaveBeenCalled()
  })

  it('reloads the definitions when the connection returns', async () => {
    const harness = await createHarness({ config: configText('remote-a') })
    await waitFor(async () => (await harness.service.listTriggers()).length === 1)

    harness.connections.setState('reconnecting')
    await waitFor(async () => (await harness.service.listTriggers())[0]?.offline === true)

    harness.files.files.set(CONFIG_URI.toString(), configText('remote-b'))
    harness.connections.setState('connected')
    await waitFor(async () => {
      const [summary] = await harness.service.listTriggers()
      return summary?.id === 'remote-b' && summary.offline === false
    })
  })

  it('detaches the remote store when the last window for the workspace closes', async () => {
    const harness = await createHarness({ config: configText('remote-a') })
    await waitFor(async () => (await harness.service.listTriggers()).length === 1)

    harness.service.unregisterWindowHost(1)
    await waitFor(async () => (await harness.service.listTriggers()).length === 0)
    expect((await harness.service.listWorkspaces()).map((entry) => entry.workspace)).toEqual([
      WORKSPACE.toString(),
    ])

    // Reconnecting without a window must not bring the remote workspace back.
    harness.connections.setState('reconnecting')
    harness.connections.setState('connected')
    await settle()
    expect(await harness.service.listTriggers()).toEqual([])
  })

  it('writes the example config remotely once and never overwrites it', async () => {
    const harness = await createHarness({ config: null, registerWindow: false })

    const created = await harness.service.ensureConfigFile(WORKSPACE.toString())

    expect(created).toBe(CONFIG_URI.toString())
    expect(harness.files.writes).toBe(1)
    const text = harness.files.files.get(CONFIG_URI.toString())
    expect(text).toContain('"version": 1')

    const again = await harness.service.ensureConfigFile(WORKSPACE.toString())
    expect(again).toBe(CONFIG_URI.toString())
    expect(harness.files.writes).toBe(1)
    expect(harness.files.files.get(CONFIG_URI.toString())).toBe(text)
    const listed = await harness.service.listTriggers()
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((entry) => entry.enabled === false && entry.offline === false)).toBe(true)
  })

  it('refuses to create the config while the remote host is disconnected', async () => {
    const harness = await createHarness({
      config: null,
      state: 'reconnecting',
      registerWindow: false,
    })

    await expect(harness.service.ensureConfigFile(WORKSPACE.toString())).rejects.toThrow(
      /not connected/,
    )
    expect(harness.files.writes).toBe(0)
  })
})

describe('TriggerMainService remote poll', () => {
  it('runs the poll command through triggerPoll with the remote workspace URI', async () => {
    const harness = await createHarness({
      config: configText('remote-poll', { source: pollSource() }),
    })
    await discoverAndConfirm(harness)
    await harness.clock.advance(0)

    await waitFor(() => harness.poll.mock.calls.length > 0)
    const request = harness.poll.mock.calls[0]![0]
    expect(request.cwd.toString()).toBe(WORKSPACE.toString())
    expect(request.command).toBe('gh pr list')
    expect(request.keyField).toBe('id')
    expect(request.timeoutSec).toBe(1)
    expect(harness.proxyChannels).toEqual([RemoteChannels.TriggerPoll])
    expect(harness.startRun).not.toHaveBeenCalled()
  })

  it('seeds the remote baseline and accepts new items on later polls', async () => {
    const harness = await createHarness({
      config: configText('remote-poll', { source: pollSource() }),
      pollImpl: async () => ({ ok: true, items: [{ key: 'A', payload: { id: 'A' } }] }),
    })
    await discoverAndConfirm(harness)
    await harness.clock.advance(0)
    await waitFor(() => harness.poll.mock.calls.length === 1)
    expect(harness.startRun).not.toHaveBeenCalled()

    harness.poll.mockResolvedValue({ ok: true, items: [{ key: 'B', payload: { id: 'B' } }] })
    await harness.clock.advance(30_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toBe('poll:B')
    expect(harness.requests[0]?.payload).toEqual({ id: 'B' })
  })

  it('skips (without failing) when the remote host is offline', async () => {
    const harness = await createHarness({
      config: configText('remote-poll', { source: pollSource() }),
    })
    await discoverAndConfirm(harness)
    await harness.clock.advance(0)
    await waitFor(() => harness.poll.mock.calls.length === 1)

    harness.connections.setState('reconnecting')
    await settle()
    await harness.clock.advance(30_000)
    await settle()

    expect(harness.poll).toHaveBeenCalledTimes(1)
    const [summary] = await harness.service.listTriggers()
    expect(summary?.consecutiveFailures).toBe(0)
    expect(summary?.lastError).toBeUndefined()
  })

  it('abandons a poll RPC that never answers without recording a failure', async () => {
    const harness = await createHarness({
      config: configText('remote-poll', { source: pollSource() }),
      pollImpl: () => new Promise<TriggerPollResult>(() => undefined),
      remotePollGraceMs: 100,
    })
    await discoverAndConfirm(harness)
    await harness.clock.advance(0)
    await waitFor(() => harness.poll.mock.calls.length === 1)

    await harness.clock.advance(1_000 + 100)
    await waitFor(() => harness.loggerLines.some((line) => line.includes('remote poll skipped')))

    const [summary] = await harness.service.listTriggers()
    expect(summary?.consecutiveFailures).toBe(0)
    expect(summary?.lastError).toBeUndefined()
  })

  it('records a failure when the remote poll answers ok:false', async () => {
    const harness = await createHarness({
      config: configText('remote-poll', { source: pollSource() }),
      pollImpl: async () => ({ ok: false, error: 'gh is not installed on the remote host' }),
    })
    await discoverAndConfirm(harness)
    await harness.clock.advance(0)

    await waitFor(async () => {
      const [summary] = await harness.service.listTriggers()
      return summary?.consecutiveFailures === 1
    })
    const [summary] = await harness.service.listTriggers()
    expect(summary?.lastError).toContain('gh is not installed')
  })
})

describe('TriggerMainService remote run pipeline', () => {
  it('creates the remote run directory with the machine client id and protected ids', async () => {
    const harness = await createHarness({
      config: configText('remote-a', { session: { cwd: 'sub' } }),
      clientId: 'client-abc',
    })
    await discoverAndConfirm(harness)
    const [summary] = await harness.service.listTriggers()

    await harness.service.runNow(summary!.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))

    const request = harness.requests[0]!
    const runId = request.origin.runId
    expect(harness.createRunDir).toHaveBeenCalledTimes(1)
    const [clientIdArg, runIdArg, options] = harness.createRunDir.mock.calls[0]!
    expect(clientIdArg).toBe('client-abc')
    expect(runIdArg).toBe(runId)
    expect(options.protectedRunIds).toContain(runId)
    expect(options.keep).toBe(200)

    expect(request.authority).toBe(AUTHORITY)
    expect(request.cwd).toBe('/home/testuser/proj/sub')
    expect(request.runDir).toBe(
      `/home/testuser/.universe-editor-server/triggers/runs/client-abc/${runId}`,
    )
    expect(request.prompt).toContain(request.runDir)
    expect(await harness.service.listTriggers()).toContainEqual(
      expect.objectContaining({ key: summary!.key, running: 1 }),
    )
  })

  it('defers an accepted run when no window holds the remote workspace and replays it later', async () => {
    const harness = await createHarness({
      config: configText('remote-a'),
      windowVisible: false,
    })
    await discoverAndConfirm(harness)
    const [summary] = await harness.service.listTriggers()

    await harness.service.runNow(summary!.key)
    await waitFor(() => harness.loggerLines.some((line) => line.includes('deferred')))

    expect(harness.startRun).not.toHaveBeenCalled()
    expect(harness.connections.proxyChannels).toEqual([])
    expect(harness.openWindow).not.toHaveBeenCalled()
    expect(harness.createRunDir).not.toHaveBeenCalled()
    const [deferred] = await harness.service.listTriggers()
    expect(deferred?.consecutiveFailures).toBe(0)
    expect(deferred?.lastError).toBeUndefined()
    expect(deferred?.running).toBe(0)
    expect(deferred?.queued).toBe(0)
    expect(harness.pendingCount()).toBe(1)

    // The workspace window returns while the connection is still connected.
    harness.showWindow()
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey.startsWith('manual:')).toBe(true)
    expect(harness.pendingCount()).toBe(0)
  })

  it('refuses a manual run while offline and leaves nothing pending', async () => {
    const harness = await createHarness({ config: configText('remote-a') })
    await discoverAndConfirm(harness)
    const [summary] = await harness.service.listTriggers()

    harness.connections.setState('reconnecting')
    await waitFor(async () => (await harness.service.listTriggers())[0]?.offline === true)
    // A manual run is refused outright while offline, so stage the pending event
    // through the replay path instead: it must stay pending, not fail.
    await expect(harness.service.runNow(summary!.key)).rejects.toThrow(/not connected/)
    expect(harness.pendingCount()).toBe(0)
    expect(harness.connections.createRunDir).not.toHaveBeenCalled()
  })
})

describe('TriggerMainService remote run reports', () => {
  it('returns unavailable without touching the channel while disconnected', async () => {
    const harness = await createHarness({
      config: configText('remote-a'),
      state: 'reconnecting',
      registerWindow: false,
    })

    expect(await harness.service.readRunReport(RUN_ID, AUTHORITY)).toEqual({
      kind: 'unavailable',
    })
    expect(harness.proxyChannels).toEqual([])
  })

  it('reads the remote report through triggerPoll and keeps the remote run dir URI', async () => {
    const harness = await createHarness({ config: configText('remote-a') })
    const runDir = remoteRunDir(CLIENT_ID, RUN_ID)
    harness.readReport.mockResolvedValue({
      ok: true,
      bytes: new TextEncoder().encode('# 远端报告\n'),
      runDir,
      modifiedAt: 123,
    })

    const result = await harness.service.readRunReport(RUN_ID, AUTHORITY)

    expect(harness.readReport).toHaveBeenCalledWith(CLIENT_ID, RUN_ID, {
      maxBytes: MAX_TRIGGER_REPORT_BYTES,
    })
    expect(result).toEqual({
      kind: 'ok',
      text: '# 远端报告\n',
      runDir: runDir.toString(),
      modifiedAt: 123,
    })
  })

  it('maps not_found / too_large / transport failures', async () => {
    const harness = await createHarness({ config: configText('remote-a') })

    harness.readReport.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect(await harness.service.readRunReport(RUN_ID, AUTHORITY)).toEqual({ kind: 'not-found' })

    harness.readReport.mockResolvedValueOnce({ ok: false, reason: 'too_large' })
    expect(await harness.service.readRunReport(RUN_ID, AUTHORITY)).toEqual({ kind: 'too-large' })

    harness.readReport.mockRejectedValueOnce(new Error('socket closed'))
    expect(await harness.service.readRunReport(RUN_ID, AUTHORITY)).toEqual({
      kind: 'unavailable',
    })
    expect(harness.loggerLines.some((line) => line.includes('socket closed'))).toBe(true)
  })

  it('rejects a malformed run id before calling the channel', async () => {
    const harness = await createHarness({ config: configText('remote-a') })

    expect(await harness.service.readRunReport('../escape', AUTHORITY)).toEqual({
      kind: 'not-found',
    })
    expect(harness.readReport).not.toHaveBeenCalled()
  })
})
