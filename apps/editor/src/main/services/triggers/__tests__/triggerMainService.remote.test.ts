/*---------------------------------------------------------------------------------------------
 *  Remote workspace trigger configs: discovery is gated on the connection state,
 *  disconnects keep an offline snapshot, reconnects reload it, and the last window
 *  closing detaches the remote store entirely.
 *--------------------------------------------------------------------------------------------*/

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  Emitter,
  Event,
  URI,
  type IFileService,
  type ILogger,
  type IOpenWindowInfo,
  type IRemoteEnvironment,
} from '@universe-editor/platform'
import type { ITriggerRunHost } from '../../../../shared/ipc/triggerService.js'
import type { TriggersConfig } from '../../../../shared/triggers/types.js'
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

const BUDGET = { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 }

function configText(id: string, name = id): string {
  const config: TriggersConfig = {
    version: 1,
    triggers: [
      {
        id,
        name,
        enabled: true,
        showSession: false,
        source: { type: 'manual' },
        session: { prompt: 'Do it', budget: BUDGET },
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
  private readonly _onDidChangeState = new Emitter<IRemoteConnectionStateChange>()
  readonly onDidChangeState = this._onDidChangeState.event

  private readonly _connection: IRemoteConnection = {
    authority: AUTHORITY,
    env: {} as IRemoteEnvironment,
    getChannel: () => ({
      call: async <T,>(_command: string): Promise<T> => {
        this.channelCalls++
        return undefined as T
      },
      listen: () => Event.None,
    }),
    onDidClose: Event.None,
  }

  getState = (_authority: string): RemoteConnectionState | undefined => this.state

  getConnection = async (_authority: string): Promise<IRemoteConnection> => {
    this.connectionCalls++
    return this._connection
  }

  setState(state: RemoteConnectionState): void {
    this.state = state
    this._onDidChangeState.fire({ authority: AUTHORITY, state })
  }
}

class FakeClock implements TriggerClock {
  now = (): number => Date.now()
  setTimeout = (callback: () => void, ms: number): unknown => setTimeout(callback, ms)
  clearTimeout = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

interface HarnessOptions {
  readonly state?: RemoteConnectionState
  readonly config?: string | null
  readonly registerWindow?: boolean
}

interface Harness {
  readonly service: TriggerMainService
  readonly files: FakeFileService
  readonly connections: FakeConnections
  readonly loggerLines: string[]
  readonly startRun: ReturnType<typeof vi.fn>
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
  const { logger, lines } = createLogger()
  const host: ITriggerRunHost = {
    _serviceBrand: undefined,
    startRun: vi.fn(async () => ({ sessionId: 'session-1' })),
    cancelRun: vi.fn(async () => undefined),
    isWorkspaceTrusted: vi.fn(async () => true),
  }
  const service = new TriggerMainService({
    userDataDir: dir,
    logger,
    clock: new FakeClock(),
    startupGraceMs: 0,
    readMaxConcurrentRuns: async () => 2,
    fileService: files as unknown as IFileService,
    remoteConnections: connections as unknown as IRemoteConnectionService,
  })
  services.push(service)
  const windows: IOpenWindowInfo[] = []
  const provider: TriggerWindowProvider = {
    getOpenWindowInfos: () => windows,
    openWindowForFolderInBackground: async () => undefined,
  }
  service.setWindowProvider(provider)
  if (options.registerWindow !== false) {
    windows.push({ id: 1, folder: WORKSPACE.toJSON(), name: 'remote' })
    service.registerWindowHost(1, host, WORKSPACE)
  }
  await service.initialize()
  await settle()
  return {
    service,
    files,
    connections,
    loggerLines: lines,
    startRun: host.startRun as unknown as ReturnType<typeof vi.fn>,
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
