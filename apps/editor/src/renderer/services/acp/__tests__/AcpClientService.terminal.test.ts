/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpClientService.ts —
 *  focused on the Stage 9 terminal/* routing. Drives AcpClientService.connect()
 *  with an in-memory AcpHostService and injects peer-initiated terminal JSON-RPC
 *  requests through the harness. We assert (a) params are translated correctly,
 *  (b) ownership is enforced per-connection, and (c) a connection exit reaps
 *  outstanding terminals.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
  type IDisposable,
} from '@universe-editor/platform'
import type {
  IConfigurationService,
  IFileService,
  IHostService,
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IOutputChannel,
  IOutputService,
  IProgressService,
} from '@universe-editor/platform'
import { AcpClientService } from '../acpClientService.js'
import type { IAcpClientNotificationSink } from '../acpClientService.js'
import { AcpPathPolicy } from '../acpPathPolicy.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IClaudeBinaryService } from '../../../../shared/ipc/claudeBinaryService.js'
import type { ICodexBinaryService } from '../../../../shared/ipc/codexBinaryService.js'
import type {
  AcpExitEvent,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../../shared/ipc/acpHostService.js'
import type { IAcpTerminalService } from '../../../../shared/ipc/acpTerminalService.js'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'

interface InMemoryAcpHostHarness extends IDisposable {
  readonly host: IAcpHostService
  readonly handle: string
  inject(data: string): void
  written(): readonly string[]
  starts(): number
  exit(code: number | null, signal: string | null): void
}

function createInMemoryAcpHost(): InMemoryAcpHostHarness {
  const onStdout = new Emitter<AcpStdioChunk>()
  const onStderr = new Emitter<AcpStdioChunk>()
  const onExit = new Emitter<AcpExitEvent>()
  const handle = 'mem-' + Math.random().toString(36).slice(2, 10)
  const writes: string[] = []
  let startCount = 0
  const host: IAcpHostService = {
    _serviceBrand: undefined,
    onStdout: onStdout.event,
    onStderr: onStderr.event,
    onExit: onExit.event,
    start: () => {
      startCount++
      return Promise.resolve({ handle })
    },
    writeStdin: (_h, data) => {
      writes.push(data)
      return Promise.resolve()
    },
    stop: () => Promise.resolve(),
    probe: () => Promise.resolve(true),
  }
  return {
    host,
    handle,
    inject(data) {
      onStdout.fire({ handle, data })
    },
    written() {
      return writes
    },
    starts() {
      return startCount
    },
    exit(code, signal) {
      onExit.fire({ handle, code, signal })
    },
    dispose() {
      onStdout.dispose()
      onStderr.dispose()
      onExit.dispose()
    },
  }
}

type IAcpTransportTestHarness = InMemoryAcpHostHarness

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake', command: '/x', args: [] }]
  }
  allAgentIds(): readonly string[] {
    return ['fake']
  }
  get(_agentId: string) {
    return this.list()[0]!
  }
  resolve(_agentId: string, cwd?: string) {
    return { command: '/x', args: [], ...(cwd !== undefined ? { cwd } : {}) }
  }
  defaultAgentId() {
    return 'fake'
  }
  readonly defaultAgentIdObs = observableValue<string>('fake.defaultAgentId', 'fake')
  setDefaultAgentId(_agentId: string): void {}
  async health() {
    return { available: true }
  }
}

class StubOutputChannel implements IOutputChannel {
  readonly name: string
  readonly content: IObservable<string> = observableValue<string>('stub.output.content', '')
  disposed = false
  constructor(name: string) {
    this.name = name
  }
  append(_text: string): void {}
  appendLine(_text: string): void {}
  clear(): void {}
  dispose(): void {
    this.disposed = true
  }
}

class StubOutputService implements IOutputService {
  declare readonly _serviceBrand: undefined
  readonly channels = new Map<string, StubOutputChannel>()
  readonly channelNames: IObservable<readonly string[]> = observableValue<readonly string[]>(
    'stub.channels',
    [],
  )
  readonly activeChannelName: IObservable<string | undefined> = observableValue<string | undefined>(
    'stub.activeChannelName',
    undefined,
  )
  readonly activeChannelContent: IObservable<string> = observableValue<string>(
    'stub.activeChannelContent',
    '',
  )
  activeChannel: IOutputChannel | undefined = undefined
  createChannel(name: string): IOutputChannel {
    const ch = new StubOutputChannel(name)
    this.channels.set(name, ch)
    return ch
  }
  getChannel(name: string): IOutputChannel | undefined {
    return this.channels.get(name)
  }
  getChannels(): readonly IOutputChannel[] {
    return [...this.channels.values()]
  }
  setActiveChannel(): void {}
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue<
    readonly INotification[]
  >('stub.notifications', [])
  readonly unreadCount: IObservable<number> = observableValue<number>('stub.unread', 0)
  readonly centerVisible: IObservable<boolean> = observableValue<boolean>('stub.center', false)
  readonly captured: { message: string; severity: unknown }[] = []
  notify(opts: { severity: unknown; message: string }): INotificationHandle {
    this.captured.push({ message: opts.message, severity: opts.severity })
    return { close: () => {} } as unknown as INotificationHandle
  }
  prompt(): Promise<void> {
    return Promise.resolve()
  }
  status(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  dismiss(): void {}
  cancelProgress(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
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

interface FakeTerminalService extends IAcpTerminalService {
  readonly create: ReturnType<typeof vi.fn>
  readonly output: ReturnType<typeof vi.fn>
  readonly waitForExit: ReturnType<typeof vi.fn>
  readonly kill: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
}

function makeFakeTerminalService(): FakeTerminalService {
  let seq = 0
  const create = vi.fn(
    async (_spec: Omit<CreateTerminalRequest, 'sessionId'>): Promise<CreateTerminalResponse> => ({
      terminalId: `t${++seq}`,
    }),
  )
  const output = vi.fn(
    async (_id: string): Promise<TerminalOutputResponse> => ({
      output: '',
      truncated: false,
    }),
  )
  const waitForExit = vi.fn(
    async (_id: string): Promise<WaitForTerminalExitResponse> => ({ exitCode: 0 }),
  )
  const kill = vi.fn(async (_id: string): Promise<void> => {})
  const release = vi.fn(async (_id: string): Promise<void> => {})
  return {
    _serviceBrand: undefined,
    create,
    output,
    waitForExit,
    kill,
    release,
  } as unknown as FakeTerminalService
}

interface Harness {
  readonly svc: AcpClientService
  readonly terminals: FakeTerminalService
  readonly notifications: StubNotificationService
  readonly transport: IAcpTransportTestHarness
  readonly sink: IAcpClientNotificationSink
  /** Inject a peer JSON-RPC request and resolve with the next response payload. */
  callPeer(
    method: string,
    params: unknown,
    id?: number,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }>
}

function makeService(opts: { autoInitialize?: boolean; startupTimeoutMs?: number } = {}): Harness {
  const transport = createInMemoryAcpHost()
  const terminals = makeFakeTerminalService()
  const notifications = new StubNotificationService()
  const files = {} as IFileService
  const pathPolicy = new AcpPathPolicy({ platform: 'linux', home: '/home/user' })
  const sink: IAcpClientNotificationSink = {
    onSessionUpdate: vi.fn(),
    onRequestPermission: vi.fn(),
    onAskUserQuestion: vi.fn(),
  }
  const svc = new AcpClientService(
    transport.host,
    new FakeAgentRegistry(),
    pathPolicy,
    files,
    new StubOutputService(),
    notifications,
    new NoopTelemetryService(),
    terminals,
    {
      onDidChangeProgress: new Emitter<never>().event,
      resolve: () => Promise.resolve({ path: '/x' }),
    } as unknown as IClaudeBinaryService,
    {
      onDidChangeProgress: new Emitter<never>().event,
      resolve: () => Promise.resolve({ path: '/x' }),
    } as unknown as ICodexBinaryService,
    {
      get: (key: string) => (key === 'acp.startupTimeoutMs' ? opts.startupTimeoutMs : undefined),
    } as unknown as IConfigurationService,
    {
      withProgress: (_o: unknown, task: (p: { report: () => void }) => unknown) =>
        task({ report: () => {} }),
    } as unknown as IProgressService,
    new StubLoggerService(),
    { platform: 'linux' } as IHostService,
  )
  svc.setNotificationSink(sink)
  // Connect now awaits initializeResult — auto-respond to the SDK's
  // initialize request so connect() can return. Tests covering a hung handshake
  // opt out via `autoInitialize: false`.
  if (opts.autoInitialize ?? true) {
    let initialized = false
    void (async () => {
      for (let i = 0; i < 500 && !initialized; i++) {
        const writes = transport.written()
        const init = writes.find((w) => w.includes('"method":"initialize"'))
        if (init) {
          try {
            const req = JSON.parse(init.trim()) as { id: number }
            transport.inject(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
              }) + '\n',
            )
            initialized = true
          } catch {
            // try again
          }
          return
        }
        await new Promise((r) => setTimeout(r, 1))
      }
    })()
  }
  let nextId = 100
  return {
    svc,
    terminals,
    notifications,
    transport,
    sink,
    async callPeer(method, params, id) {
      const reqId = id ?? nextId++
      const writesBefore = transport.written().length
      transport.inject(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n')
      for (let i = 0; i < 50; i++) {
        if (transport.written().length > writesBefore) break
        await new Promise((r) => setTimeout(r, 0))
      }
      const last = transport.written().slice(writesBefore).pop()
      if (!last) throw new Error(`callPeer: no response written for ${method}`)
      const resp = JSON.parse(last.trim()) as {
        id: unknown
        result?: unknown
        error?: { code: number; message: string }
      }
      if (resp.id !== reqId) {
        throw new Error(`callPeer: response id mismatch: expected ${reqId}, got ${String(resp.id)}`)
      }
      return resp
    },
  }
}

const SESSION_ID = 'sess-1'
const CWD = '/work/proj'

describe('AcpClientService — terminal/create routing', () => {
  let h: Harness
  afterEach(() => {
    h.transport.dispose()
  })

  it('passes command/args/env/cwd into IAcpTerminalService.create and returns the id', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      const resp = await h.callPeer('terminal/create', {
        sessionId: SESSION_ID,
        command: 'rg',
        args: ['--json', 'pattern'],
        env: [{ name: 'FOO', value: 'bar' }],
        cwd: `${CWD}/src`,
        outputByteLimit: 8192,
      })
      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ terminalId: 't1' })
      expect(h.terminals.create).toHaveBeenCalledTimes(1)
      const passed = h.terminals.create.mock.calls[0]![0] as Omit<
        CreateTerminalRequest,
        'sessionId'
      >
      expect(passed.command).toBe('rg')
      expect(passed.args).toEqual(['--json', 'pattern'])
      expect(passed.env).toEqual([{ name: 'FOO', value: 'bar' }])
      expect(passed.cwd).toBe(`${CWD}/src`)
      expect(passed.outputByteLimit).toBe(8192)
    } finally {
      conn.dispose()
    }
  })

  it('defaults args to [] when omitted and drops env/cwd when absent', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      const resp = await h.callPeer('terminal/create', {
        sessionId: SESSION_ID,
        command: 'ls',
      })
      expect(resp.error).toBeUndefined()
      const passed = h.terminals.create.mock.calls[0]![0] as Omit<
        CreateTerminalRequest,
        'sessionId'
      >
      expect(passed.args).toBeUndefined()
      expect(passed.env).toBeUndefined()
      expect(passed.cwd).toBeUndefined()
      expect(passed.outputByteLimit).toBeUndefined()
    } finally {
      conn.dispose()
    }
  })

  it('rejects cwd outside the session sandbox with -32602 and notifies', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      const resp = await h.callPeer('terminal/create', {
        sessionId: SESSION_ID,
        command: 'ls',
        cwd: '/etc/passwd',
      })
      expect(resp.error?.code).toBe(-32602)
      expect(resp.error?.message).toMatch(/terminal\/create rejected/)
      expect(h.terminals.create).not.toHaveBeenCalled()
      expect(h.notifications.captured.length).toBe(1)
      expect(h.notifications.captured[0]!.message).toMatch(/terminal-cwd/)
    } finally {
      conn.dispose()
    }
  })

  it('rejects malformed terminal/create params with -32602', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      const resp = await h.callPeer('terminal/create', { sessionId: SESSION_ID })
      expect(resp.error?.code).toBe(-32602)
      expect(resp.error?.message).toMatch(/Invalid params/)
      expect(h.terminals.create).not.toHaveBeenCalled()
    } finally {
      conn.dispose()
    }
  })
})

describe('AcpClientService — terminal/output|kill|wait|release routing', () => {
  let h: Harness
  afterEach(() => {
    h.transport.dispose()
  })

  it('terminal/output proxies to the service and surfaces truncated/exitStatus', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      h.terminals.output.mockResolvedValueOnce({
        output: 'hello',
        truncated: true,
        exitStatus: { exitCode: 7 },
      })
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'ls' })
      const resp = await h.callPeer('terminal/output', {
        sessionId: SESSION_ID,
        terminalId: 't1',
      })
      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({
        output: 'hello',
        truncated: true,
        exitStatus: { exitCode: 7 },
      })
      expect(h.terminals.output).toHaveBeenCalledWith('t1')
    } finally {
      conn.dispose()
    }
  })

  it('terminal/wait_for_exit returns the exit status verbatim', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      h.terminals.waitForExit.mockResolvedValueOnce({ signal: 'SIGTERM' })
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'sleep' })
      const resp = await h.callPeer('terminal/wait_for_exit', {
        sessionId: SESSION_ID,
        terminalId: 't1',
      })
      expect(resp.result).toEqual({ signal: 'SIGTERM' })
    } finally {
      conn.dispose()
    }
  })

  it('terminal/kill returns an empty object on success', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'sleep' })
      const resp = await h.callPeer('terminal/kill', {
        sessionId: SESSION_ID,
        terminalId: 't1',
      })
      expect(resp.error).toBeUndefined()
      // SDK serializes the void-returning killTerminal handler as `{}`.
      expect(resp.result).toEqual({})
      expect(h.terminals.kill).toHaveBeenCalledWith('t1')
    } finally {
      conn.dispose()
    }
  })

  it('terminal/release calls the service and forgets ownership', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'sleep' })
      const ok = await h.callPeer('terminal/release', {
        sessionId: SESSION_ID,
        terminalId: 't1',
      })
      expect(ok.error).toBeUndefined()
      // After release, the connection no longer owns the id — subsequent
      // operations through this connection must reject.
      const after = await h.callPeer('terminal/output', {
        sessionId: SESSION_ID,
        terminalId: 't1',
      })
      expect(after.error?.code).toBe(-32602)
      expect(after.error?.message).toMatch(/Unknown terminal/)
      expect(h.terminals.release).toHaveBeenCalledWith('t1')
    } finally {
      conn.dispose()
    }
  })
})

describe('AcpClientService — terminal ownership gating', () => {
  let h: Harness
  afterEach(() => {
    h.transport.dispose()
  })

  it('rejects output/kill/wait/release for unknown terminal ids with -32602', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      for (const method of [
        'terminal/output',
        'terminal/kill',
        'terminal/wait_for_exit',
        'terminal/release',
      ]) {
        const resp = await h.callPeer(method, {
          sessionId: SESSION_ID,
          terminalId: 'never-created',
        })
        expect(resp.error?.code).toBe(-32602)
        expect(resp.error?.message).toMatch(/Unknown terminal/)
      }
      expect(h.terminals.output).not.toHaveBeenCalled()
      expect(h.terminals.kill).not.toHaveBeenCalled()
      expect(h.terminals.waitForExit).not.toHaveBeenCalled()
      expect(h.terminals.release).not.toHaveBeenCalled()
    } finally {
      conn.dispose()
    }
  })

  it('rejects all four terminal operations when params themselves are malformed', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      for (const method of [
        'terminal/output',
        'terminal/kill',
        'terminal/wait_for_exit',
        'terminal/release',
      ]) {
        const resp = await h.callPeer(method, { sessionId: SESSION_ID })
        expect(resp.error?.code).toBe(-32602)
        expect(resp.error?.message).toMatch(/Invalid params/)
      }
    } finally {
      conn.dispose()
    }
  })
})

describe('AcpClientService — connection exit reaps owned terminals', () => {
  let h: Harness
  afterEach(() => {
    h.transport.dispose()
  })

  it('releases each owned terminal once when the agent process exits', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      h.terminals.create
        .mockResolvedValueOnce({ terminalId: 'r-1' })
        .mockResolvedValueOnce({ terminalId: 'r-2' })
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'a' })
      await h.callPeer('terminal/create', { sessionId: SESSION_ID, command: 'b' })

      h.transport.exit(0, null)
      await new Promise((r) => setTimeout(r, 5))
      const releaseCalls = h.terminals.release.mock.calls.map((c) => c[0] as string)
      expect(releaseCalls.sort()).toEqual(['r-1', 'r-2'])
    } finally {
      conn.dispose()
    }
  })

  it('does not call release after the agent exits with no terminals owned', async () => {
    h = makeService()
    const conn = await h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })
    try {
      h.transport.exit(0, null)
      await new Promise((r) => setTimeout(r, 5))
      expect(h.terminals.release).not.toHaveBeenCalled()
    } finally {
      conn.dispose()
    }
  })
})

describe('AcpClientService — connect handshake timeout', () => {
  let h: Harness
  afterEach(() => {
    h.transport.dispose()
  })

  it('rejects and evicts the pool entry when initialize never responds', async () => {
    // No auto-initialize responder + a tiny startup timeout: the spawned process
    // boots but the ACP handshake never completes. connect() must reject (rather
    // than hang forever, which is what wedged resumeSession into an endless
    // "Resuming agent session…" spinner) and tear the entry down.
    h = makeService({ autoInitialize: false, startupTimeoutMs: 20 })
    await expect(h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })).rejects.toThrow(
      /timed out/,
    )
    expect(h.transport.starts()).toBe(1)

    // Entry was evicted → the next connect() re-spawns instead of awaiting the
    // same dead handshake promise.
    await expect(h.svc.connect('fake', { cwd: CWD, leaseFor: SESSION_ID })).rejects.toThrow(
      /timed out/,
    )
    expect(h.transport.starts()).toBe(2)
  })
})
