/*---------------------------------------------------------------------------------------------
 *  Tests for the main-side MCP client.
 *
 *  Two layers, on purpose:
 *    - the protocol layer runs a REAL MCP `Server` over `InMemoryTransport`, so the
 *      request/response shapes and error codes are exercised without a process;
 *    - the stdio layer spawns the real `mcpDebugServer.cjs` fixture through the real
 *      `AcpHostService` core, so framing and process lifecycle are exercised for real.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { AcpHostService } from '@universe-editor/node-services'
import { LogLevel, type ILogger, type ILoggerService } from '@universe-editor/platform'
import { McpClientMainService, createWindowScopedMcpClient } from '../mcpClientMainService.js'
import { ErrorCode, McpError, UnauthorizedError, type McpTransport } from '../mcpSdk.js'
import type {
  McpConnectTargetDto,
  McpConnectionClosedDto,
} from '../../../../shared/ipc/mcpClientService.js'

const FIXTURE = fileURLToPath(
  new URL('../../../../test-fixtures/mcpDebugServer.cjs', import.meta.url),
)

const HTTP_TARGET: McpConnectTargetDto = { kind: 'http', url: 'https://gallery.example.com/mcp' }

const cleanups: (() => unknown)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/**
 * The SDK's own test transports are declared without `exactOptionalPropertyTypes`,
 * so none of them satisfies its `Transport` interface structurally — hence the one
 * cast, confined to tests.
 */
function asTransport(value: unknown): McpTransport {
  return value as McpTransport
}

/**
 * A fresh in-memory server + client transport per call — one connection per pair,
 * exactly like the real thing (`connect` closes, and the SDK takes over, whatever
 * transport it was handed).
 */
function inMemoryTransports(
  handlers: {
    list?: () => Promise<{ tools: unknown[] }>
    call?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>
  } = {},
): () => McpTransport {
  return () => {
    const server = new Server(
      { name: 'in-memory-fixture', version: '9.9.9' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () =>
      handlers.list
        ? (handlers.list() as never)
        : ({
            tools: [
              {
                name: 'echo',
                title: 'Echo',
                description: 'Echoes.',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          } as never),
    )
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      if (handlers.call) return handlers.call(name, args)
      if (name === 'fail') {
        return { isError: true, content: [{ type: 'text', text: 'nope' }] }
      }
      return {
        content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }],
        structuredContent: { echoed: args.text },
      }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    // `connect` installs the message handler synchronously, so the client may send
    // `initialize` as soon as we hand the other end back.
    void server.connect(asTransport(serverTransport)).catch(() => undefined)
    cleanups.push(() => server.close())
    return asTransport(clientTransport)
  }
}

/**
 * A real in-memory transport behind a switch that can start failing mid-call — the
 * closest stand-in for an http/sse stream that dies after the handshake (those never
 * fire `onclose`, so main has to notice some other way).
 */
function forwardingTransport(base: McpTransport, isBroken: () => boolean): McpTransport {
  return new Proxy(base, {
    get: (target, prop, receiver) =>
      prop === 'send' && isBroken()
        ? () => Promise.reject(new Error('fetch failed'))
        : Reflect.get(target, prop, receiver),
  })
}

function makeService(options: {
  transport?: McpTransport
  createTransport?: () => McpTransport
  idleTtlMs?: number
  stdioHost?: AcpHostService
  loggerService?: ILoggerService
}): McpClientMainService {
  const factory =
    options.createTransport ??
    (options.transport !== undefined ? () => options.transport as McpTransport : undefined)
  const service = new McpClientMainService(options.loggerService, {
    idleTtlMs: options.idleTtlMs ?? 0,
    ...(factory !== undefined ? { createTransport: factory } : {}),
    ...(options.stdioHost !== undefined ? { stdioHost: options.stdioHost } : {}),
  })
  cleanups.push(() => service.dispose())
  return service
}

describe('McpClientMainService over the MCP protocol (in-memory transport)', () => {
  it('connects, reports serverInfo and lists the tools', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const result = await service.connect(HTTP_TARGET, 5_000, 7)
    expect(result.connectionId).toMatch(/[0-9a-f-]{36}/)
    expect(result.serverName).toBe('in-memory-fixture')
    expect(result.serverVersion).toBe('9.9.9')
    expect(result.tools).toEqual([
      {
        name: 'echo',
        title: 'Echo',
        description: 'Echoes.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ])
  })

  it('re-lists tools on an open connection', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    expect((await service.listTools(connectionId, 5_000)).map((t) => t.name)).toEqual(['echo'])
  })

  it('passes the MCP-level isError straight through, with content and timing', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    const ok = await service.callTool(connectionId, 'echo', { text: 'hi' }, 5_000)
    expect(ok.isError).toBe(false)
    expect(ok.content).toEqual([{ type: 'text', text: 'echo: hi' }])
    expect(ok.structuredContent).toEqual({ echoed: 'hi' })
    expect(ok.durationMs).toBeGreaterThanOrEqual(0)

    const bad = await service.callTool(connectionId, 'fail', {}, 5_000)
    expect(bad.isError).toBe(true)
    expect(bad).not.toHaveProperty('structuredContent')
  })

  it('rejects calls on an unknown or disconnected connection with MCP_UNKNOWN_CONNECTION', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    await service.disconnect(connectionId)
    await expect(service.callTool(connectionId, 'echo', {}, 5_000)).rejects.toMatchObject({
      code: 'MCP_UNKNOWN_CONNECTION',
    })
    await expect(service.listTools('never-existed', 5_000)).rejects.toMatchObject({
      code: 'MCP_UNKNOWN_CONNECTION',
    })
  })

  it('classifies a JSON-RPC error reply as MCP_SERVER_ERROR, not a protocol violation', async () => {
    const service = makeService({
      createTransport: inMemoryTransports({
        call: () => {
          throw new McpError(ErrorCode.InvalidParams, 'Unknown tool: nope')
        },
      }),
    })
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    const err = await service
      .callTool(connectionId, 'nope', {}, 5_000)
      .then(() => undefined)
      .catch((e: unknown) => e as { code?: string; message?: string })
    expect(err?.code).toBe('MCP_SERVER_ERROR')
    expect(err?.message).toContain('Unknown tool: nope')
    // The server spoke MCP correctly — its refusal does not close the connection.
    expect((await service.listTools(connectionId, 5_000)).length).toBe(1)
  })

  it('reclaims a connection whose failure means the link itself is gone', async () => {
    let broken = false
    const base = inMemoryTransports()()
    const service = makeService({
      createTransport: () => forwardingTransport(base, () => broken),
    })
    const events: McpConnectionClosedDto[] = []
    service.onDidCloseConnection((e) => events.push(e))
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)

    broken = true
    await expect(service.callTool(connectionId, 'echo', {}, 5_000)).rejects.toMatchObject({
      code: 'MCP_CONNECT_FAILED',
    })
    // Without this the panel would keep showing "connected" and fail every Run.
    expect(events.map((e) => e.reason)).toEqual(['transport-error'])
    await expect(service.listTools(connectionId, 5_000)).rejects.toMatchObject({
      code: 'MCP_UNKNOWN_CONNECTION',
    })
  })

  it('classifies a transport that cannot even be built', async () => {
    const service = makeService({
      createTransport: () => {
        throw new Error('Invalid URL')
      },
    })
    await expect(service.connect(HTTP_TARGET, 5_000)).rejects.toMatchObject({
      code: 'MCP_CONNECT_FAILED',
    })
  })

  it('reclaims a window but leaves other windows alone', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const mine = await service.connect(HTTP_TARGET, 5_000, 3)
    const other = await service.connect(HTTP_TARGET, 5_000, 4)
    await service.stopAllForWindow(3)
    await expect(service.listTools(mine.connectionId, 5_000)).rejects.toMatchObject({
      code: 'MCP_UNKNOWN_CONNECTION',
    })
    expect((await service.listTools(other.connectionId, 5_000)).length).toBe(1)
  })

  it('maps a rejection from the SDK auth layer to MCP_NEEDS_AUTH', async () => {
    const service = makeService({
      transport: asTransport({
        start: () => Promise.reject(new UnauthorizedError('401 Unauthorized')),
        send: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    })
    await expect(service.connect(HTTP_TARGET, 5_000)).rejects.toMatchObject({
      code: 'MCP_NEEDS_AUTH',
    })
  })

  it('maps an unresponsive server to MCP_TIMEOUT', async () => {
    // Never answers `initialize`; the transport stays open.
    const service = makeService({
      transport: asTransport({
        start: () => Promise.resolve(),
        send: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    })
    await expect(service.connect(HTTP_TARGET, 60)).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
  })

  it('never fires onDidCloseConnection for an explicit disconnect', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const closed = vi.fn()
    service.onDidCloseConnection(closed)
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    await service.disconnect(connectionId)
    await service.disconnect(connectionId)
    expect(closed).not.toHaveBeenCalled()
  })

  it('reaps an idle connection and says why', async () => {
    const service = makeService({ createTransport: inMemoryTransports(), idleTtlMs: 10 })
    const events: McpConnectionClosedDto[] = []
    service.onDidCloseConnection((e) => events.push(e))
    const { connectionId } = await service.connect(HTTP_TARGET, 5_000)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ connectionId, reason: 'idle' })
  })

  it('reports a server-initiated close once, with the transport reason', async () => {
    let clientTransport: McpTransport | undefined
    const service = makeService({
      createTransport: () => (clientTransport = inMemoryTransports()()),
    })
    const events: McpConnectionClosedDto[] = []
    service.onDidCloseConnection((e) => events.push(e))
    await service.connect(HTTP_TARGET, 5_000)
    await clientTransport?.close()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.reason).toBe('server-exit')
  })

  it('stamps the window id through the channel-scoped wrapper', async () => {
    const service = makeService({ createTransport: inMemoryTransports() })
    const scoped = createWindowScopedMcpClient(service, 42)
    const { connectionId } = await scoped.connect(HTTP_TARGET, 5_000)
    expect((await scoped.listTools(connectionId, 5_000)).map((t) => t.name)).toEqual(['echo'])
    await service.stopAllForWindow(42)
    await expect(scoped.listTools(connectionId, 5_000)).rejects.toMatchObject({
      code: 'MCP_UNKNOWN_CONNECTION',
    })
  })
})

describe('McpClientMainService over a real child process (stdio fixture)', () => {
  const stdioTarget = (extra: Partial<{ env: Record<string, string>; cwd: string }> = {}) =>
    ({
      kind: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      ...extra,
    }) as McpConnectTargetDto

  // The default stdio host must be handed the logger service: a `NullLogger`
  // fallback leaves parentless disposables behind, which the dev leak tracker
  // reports on every editor exit. The host constructs its logger eagerly, so the
  // channels requested at service construction are the observable.
  it('wires the logger service into the default stdio host', () => {
    const channels: string[] = []
    const logger: ILogger = {
      level: LogLevel.Info,
      onDidChangeLogLevel: () => ({ dispose: () => {} }),
      setLevel: () => {},
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      flush: () => {},
      dispose: () => {},
    }
    makeService({
      loggerService: {
        _serviceBrand: undefined,
        createLogger: (channel) => {
          channels.push(channel.id)
          return logger
        },
        setLevel: () => {},
        getLevel: () => LogLevel.Info,
      },
    })
    expect(channels).toContain('acpHost')
  })

  it('drives the full stdio path: spawn, initialize, list and call', async () => {
    const service = makeService({ stdioHost: new AcpHostService() })
    const result = await service.connect(stdioTarget(), 15_000, 11)
    expect(result.serverName).toBe('mcp-debug-fixture')
    expect(result.serverVersion).toBe('1.2.3')
    expect(result.instructions).toBe('Fixture server for the replay debugger.')
    expect(result.tools.map((t) => t.name)).toEqual(['echo', 'fail'])
    expect(result.tools[0]?.title).toBe('Echo')

    const echo = await service.callTool(result.connectionId, 'echo', { text: 'hello 中文' }, 15_000)
    expect(echo.isError).toBe(false)
    expect(echo.content).toEqual([{ type: 'text', text: 'echo: hello 中文' }])
    expect(echo.structuredContent).toEqual({ echoed: 'hello 中文' })

    const failed = await service.callTool(result.connectionId, 'fail', { message: 'boom' }, 15_000)
    expect(failed.isError).toBe(true)
    expect(failed.content).toEqual([{ type: 'text', text: 'ERROR: boom' }])
  })

  it('passes env through and reports the masked stderr tail when the server dies', async () => {
    const service = makeService({ stdioHost: new AcpHostService() })
    const events: McpConnectionClosedDto[] = []
    service.onDidCloseConnection((e) => events.push(e))
    const { connectionId } = await service.connect(
      stdioTarget({
        env: { UE_MCP_FIXTURE_STDERR: '1', UE_MCP_FIXTURE_EXIT_MS: '20', TOKEN: 'ak-1' },
      }),
      15_000,
      12,
    )
    await service.callTool(connectionId, 'echo', { text: 'bye' }, 15_000)
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 5_000 })
    const event = events[0]
    expect(event?.reason).toBe('server-exit')
    expect(event?.detail).toContain('mcp-debug-fixture starting')
    expect(event?.detail).toContain('"token":••••')
    expect(event?.detail).not.toContain('super-secret-value')
  })

  it('classifies a missing binary as MCP_SPAWN_FAILED', async () => {
    const service = makeService({ stdioHost: new AcpHostService() })
    await expect(
      service.connect({ kind: 'stdio', command: 'ue-mcp-fixture-does-not-exist', args: [] }, 5_000),
    ).rejects.toMatchObject({ code: 'MCP_SPAWN_FAILED' })
  })

  it('classifies a server that never answers as MCP_TIMEOUT', async () => {
    const service = makeService({ stdioHost: new AcpHostService() })
    await expect(
      service.connect(stdioTarget({ env: { UE_MCP_FIXTURE_SILENT: '1' } }), 300),
    ).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
  })

  it('takes the cwd from the target so relative args resolve as the agent saw them', async () => {
    const service = makeService({ stdioHost: new AcpHostService() })
    const cwd = fileURLToPath(new URL('../../../../test-fixtures', import.meta.url))
    const result = await service.connect(
      { kind: 'stdio', command: process.execPath, args: ['mcpDebugServer.cjs'], cwd },
      15_000,
    )
    expect(result.serverName).toBe('mcp-debug-fixture')
  })
})
