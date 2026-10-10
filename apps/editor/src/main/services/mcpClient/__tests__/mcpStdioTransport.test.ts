/*---------------------------------------------------------------------------------------------
 *  Tests for the hand-rolled MCP stdio transport: framing, close-once semantics and
 *  the stderr tail. The process host is faked so chunk boundaries are exact.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter, type Event } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpLaunchSpec,
  AcpStartResult,
  AcpStdioChunk,
} from '@universe-editor/platform'
import { MCP_MAX_BUFFER_CHARS, McpStdioTransport, type McpStdioHost } from '../mcpStdioTransport.js'
import type { McpJsonRpcMessage } from '../mcpSdk.js'

const HANDLE = 'h-1'
const SPEC: AcpLaunchSpec = { command: 'node', args: ['server.cjs'] }

/** `close()` settles its bookkeeping one microtask after `stop()` resolves. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

class FakeHost implements McpStdioHost {
  readonly started: AcpLaunchSpec[] = []
  readonly writes: string[] = []
  readonly stopped: string[] = []
  private readonly _stdout = new Emitter<AcpStdioChunk>()
  private readonly _stderr = new Emitter<AcpStdioChunk>()
  private readonly _exit = new Emitter<AcpExitEvent>()
  readonly onStdout: Event<AcpStdioChunk> = this._stdout.event
  readonly onStderr: Event<AcpStdioChunk> = this._stderr.event
  readonly onExit: Event<AcpExitEvent> = this._exit.event

  async start(spec: AcpLaunchSpec): Promise<AcpStartResult> {
    this.started.push(spec)
    return { handle: HANDLE }
  }

  async writeStdin(handle: string, data: string): Promise<void> {
    this.writes.push(`${handle}:${data}`)
  }

  async stop(handle: string): Promise<void> {
    this.stopped.push(handle)
  }

  emitStdout(data: string, handle = HANDLE): void {
    this._stdout.fire({ handle, data })
  }

  emitStderr(data: string, handle = HANDLE): void {
    this._stderr.fire({ handle, data })
  }

  emitExit(exit: Partial<AcpExitEvent> = {}, handle = HANDLE): void {
    this._exit.fire({ handle, code: 0, signal: null, ...exit })
  }
}

function makeTransport(host: FakeHost): McpStdioTransport {
  return new McpStdioTransport(host, SPEC)
}

function collect(transport: McpStdioTransport): {
  messages: McpJsonRpcMessage[]
  errors: Error[]
  closes: () => number
} {
  const messages: McpJsonRpcMessage[] = []
  const errors: Error[] = []
  let closes = 0
  transport.onmessage = (message) => messages.push(message)
  transport.onerror = (err) => errors.push(err)
  transport.onclose = () => {
    closes += 1
  }
  return { messages, errors, closes: () => closes }
}

describe('McpStdioTransport', () => {
  it('starts the configured child and forwards the spec verbatim', async () => {
    const host = new FakeHost()
    await makeTransport(host).start()
    expect(host.started).toEqual([SPEC])
  })

  it('parses several messages out of one chunk', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStdout('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n')
    expect(seen.messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })

  it('reassembles a message split across chunks and tolerates CRLF', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStdout('{"jsonrpc":"2.0","id":1,"res')
    host.emitStdout('ult":{"ok":true}}\r\n')
    expect(seen.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
    expect(seen.errors).toEqual([])
  })

  it('fails the connection on a non-JSON / non-JSON-RPC line', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStdout('not json at all\n')
    expect(seen.messages).toEqual([])
    expect(transport.protocolError).toBe('MCP server wrote a non-JSON line: not json at all')
    expect(host.stopped).toEqual([HANDLE])
    // Closed, not just reported: the dropped line may have been someone's response.
    await tick()
    expect(seen.closes()).toBe(1)
  })

  it('does not dispatch further lines after failing the protocol', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStdout('{"hello":"world"}\n{"jsonrpc":"2.0","id":1,"result":{}}\n')
    expect(seen.messages).toEqual([])
    expect(transport.protocolError).toBe(
      'MCP server wrote a non-JSON-RPC message: {"hello":"world"}',
    )
    await tick()
    expect(seen.closes()).toBe(1)
  })

  it('fails the connection when stdout never sees a newline', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStdout('x'.repeat(MCP_MAX_BUFFER_CHARS + 1))
    expect(transport.protocolError).toContain('without a newline')
    expect(host.stopped).toEqual([HANDLE])
    await tick()
    expect(seen.closes()).toBe(1)
  })

  it('writes newline-delimited JSON and ignores other handles', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(host.writes).toEqual([`${HANDLE}:{"jsonrpc":"2.0","id":1,"method":"ping"}\n`])

    host.emitStdout('{"jsonrpc":"2.0","id":9,"result":{}}\n', 'someone-else')
    host.emitExit({}, 'someone-else')
    expect(seen.messages).toEqual([])
    expect(seen.closes()).toBe(0)
  })

  it('refuses to send before start', async () => {
    const transport = makeTransport(new FakeHost())
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
      /not started/,
    )
  })

  it('stops the child and fires onclose exactly once', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    await transport.close()
    await transport.close()
    expect(host.stopped).toEqual([HANDLE])
    expect(seen.closes()).toBe(1)
  })

  it('fires onerror then onclose once when the child exits', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitExit({ code: 7 })
    host.emitExit({ code: 7 })
    expect(seen.errors.map((e) => e.message)).toEqual(['MCP server exited (code 7)'])
    expect(seen.closes()).toBe(1)
    expect(transport.exit).toEqual({ kind: 'exited', code: 7, signal: null })
  })

  it('classifies a spawn failure and keeps the stderr tail, masked', async () => {
    const host = new FakeHost()
    const transport = makeTransport(host)
    const seen = collect(transport)
    await transport.start()
    host.emitStderr('starting\ntoken=ak-1\n')
    host.emitExit({ error: 'spawn npx ENOENT' })
    expect(transport.exit).toEqual({
      kind: 'spawn-failed',
      code: null,
      signal: null,
      detail: 'spawn npx ENOENT',
    })
    expect(transport.stderrTail).toBe('starting\ntoken=••••')
    expect(seen.errors).toHaveLength(1)
    expect(seen.closes()).toBe(1)
  })
})
