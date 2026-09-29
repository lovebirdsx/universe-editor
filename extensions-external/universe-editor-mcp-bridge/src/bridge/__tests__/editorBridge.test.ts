import { createServer, type Server } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorCommandBridge, mcpServicePipeName } from '../editorBridge.js'
import { discoverEditors } from '../editorDiscovery.js'
import { encodeFrame, FrameDecoder } from '../framing.js'
import { EditorMcpClientKind, EditorMcpMethod } from '../protocol.js'

const servers: Server[] = []
const bridges: EditorCommandBridge[] = []
let nextPid = 800000

async function fakeEditor(
  options: { instanceId?: string; reply?: boolean; protocolMismatch?: boolean } = {},
) {
  const pid = nextPid++
  const identity = {
    EditorPid: pid,
    InstanceId: options.instanceId ?? `instance-${pid}`,
    ProjectPath: 'X:/workspace',
  }
  const received: string[] = []
  const requests: {
    requestId: string
    socket: import('node:net').Socket
    toolName: string
    token: string
  }[] = []
  const server = createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk) => {
      for (const line of decoder.push(chunk)) {
        const message = JSON.parse(line) as {
          Type: string
          RequestId: string
          Method?: string
          Params?: { ToolName?: string; Parameters?: { Token?: string } }
        }
        if (message.Type === 'Handshake') {
          socket.write(
            encodeFrame(
              JSON.stringify(
                options.protocolMismatch
                  ? {
                      Type: 'Response',
                      RequestId: message.RequestId,
                      Success: false,
                      Error: {
                        Code: 'UNSUPPORTED_PROTOCOL_VERSION',
                        Message: 'Unsupported version',
                      },
                    }
                  : {
                      Type: 'Response',
                      RequestId: message.RequestId,
                      Success: true,
                      Result: { ProtocolVersion: 4, ServerName: 'UniverseEditor', ...identity },
                    },
              ),
            ),
          )
        } else {
          received.push(message.Method ?? '')
          requests.push({
            requestId: message.RequestId,
            socket,
            toolName: message.Params?.ToolName ?? '',
            token: message.Params?.Parameters?.Token ?? '',
          })
          if (options.reply !== false)
            socket.write(
              encodeFrame(
                JSON.stringify({
                  Type: 'Response',
                  RequestId: message.RequestId,
                  Success: true,
                  Result: {},
                }),
              ),
            )
        }
      }
    })
  })
  const path = `\\\\.\\pipe\\${mcpServicePipeName(pid)}`
  await new Promise<void>((resolve) => server.listen(path, resolve))
  servers.push(server)
  return {
    pid,
    identity,
    received,
    requests,
    respond: (request: (typeof requests)[number]) => {
      request.socket.write(
        encodeFrame(
          JSON.stringify({
            Type: 'Response',
            RequestId: request.requestId,
            Success: true,
            Result: { Token: request.token },
          }),
        ),
      )
    },
  }
}

function bridgeFor(
  pid: number,
  options: {
    expectedIdentity?: { EditorPid: number; InstanceId: string; ProjectPath: string }
    timeoutMs?: number
    clientKind?: 'mcp-probe'
    onDisconnect?: () => void
  } = {},
) {
  const bridge = new EditorCommandBridge({
    editorPid: pid,
    timeoutMs: options.timeoutMs ?? 300,
    connectTimeoutMs: 300,
    ...(options.expectedIdentity ? { expectedIdentity: options.expectedIdentity } : {}),
    ...(options.clientKind ? { clientKind: EditorMcpClientKind.McpProbe } : {}),
    ...(options.onDisconnect ? { onDisconnect: options.onDisconnect } : {}),
  })
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('EditorCommandBridge', () => {
  it('一个 bridge 探测多个同项目 UE 后只向选中的实例发送工具调用', async () => {
    const first = await fakeEditor()
    const selected = await fakeEditor()
    const candidates = await discoverEditors({
      connectTimeoutMs: 300,
      enumerate: async () => [
        { pid: selected.pid, executablePath: '', commandLine: '' },
        { pid: first.pid, executablePath: '', commandLine: '' },
      ],
    })
    expect(candidates.map((candidate) => candidate.identity.EditorPid)).toEqual([
      first.pid,
      selected.pid,
    ])
    const bridge = bridgeFor(selected.pid, { expectedIdentity: candidates[1]!.identity })
    await bridge.start()
    const response = await bridge.sendRequest(EditorMcpMethod.CallTool, {
      ToolName: 'search_object',
      Parameters: { Token: 'selected' },
    })
    expect(response).toMatchObject({ Success: true, Result: {} })
    expect(first.received).toEqual([])
    expect(selected.received).toEqual(['CallTool'])
  })

  it('两个 bridge 并发调用同一 UE 工具时，逆序回包仍匹配各自的请求', async () => {
    const editor = await fakeEditor({ reply: false })
    const first = bridgeFor(editor.pid, { expectedIdentity: editor.identity, timeoutMs: 2000 })
    const second = bridgeFor(editor.pid, { expectedIdentity: editor.identity, timeoutMs: 2000 })
    await Promise.all([first.start(), second.start()])

    const firstResult = first.sendRequest(EditorMcpMethod.CallTool, {
      ToolName: 'search_object',
      Parameters: { Token: 'first' },
    })
    const secondResult = second.sendRequest(EditorMcpMethod.CallTool, {
      ToolName: 'search_object',
      Parameters: { Token: 'second' },
    })
    await vi.waitFor(() => expect(editor.requests).toHaveLength(2))
    expect(editor.requests.map((request) => request.requestId)).toEqual([
      expect.any(String),
      expect.any(String),
    ])
    expect(new Set(editor.requests.map((request) => request.requestId)).size).toBe(2)
    expect(editor.requests.map((request) => request.toolName)).toEqual([
      'search_object',
      'search_object',
    ])
    const firstRequest = editor.requests.find((request) => request.token === 'first')!
    const secondRequest = editor.requests.find((request) => request.token === 'second')!
    editor.respond(secondRequest)
    editor.respond(firstRequest)

    expect((await firstResult).Result).toEqual({ Token: 'first' })
    expect((await secondResult).Result).toEqual({ Token: 'second' })
    expect(editor.received).toEqual(['CallTool', 'CallTool'])
  })

  it('同一个 bridge 并发调用同一工具时，逆序回包仍匹配各自的请求', async () => {
    const editor = await fakeEditor({ reply: false })
    const bridge = bridgeFor(editor.pid, { expectedIdentity: editor.identity, timeoutMs: 2000 })
    await bridge.start()

    const firstResult = bridge.sendRequest(EditorMcpMethod.CallTool, {
      ToolName: 'search_object',
      Parameters: { Token: 'first' },
    })
    const secondResult = bridge.sendRequest(EditorMcpMethod.CallTool, {
      ToolName: 'search_object',
      Parameters: { Token: 'second' },
    })
    await vi.waitFor(() => expect(editor.requests).toHaveLength(2))
    const firstRequest = editor.requests.find((request) => request.token === 'first')!
    const secondRequest = editor.requests.find((request) => request.token === 'second')!
    expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
    editor.respond(secondRequest)
    editor.respond(firstRequest)

    expect((await firstResult).Result).toEqual({ Token: 'first' })
    expect((await secondResult).Result).toEqual({ Token: 'second' })
  })

  it('UE 拒绝协议版本时返回明确的版本不兼容错误', async () => {
    const editor = await fakeEditor({ protocolMismatch: true })
    await expect(bridgeFor(editor.pid).start()).rejects.toMatchObject({
      name: 'EditorMcpVersionMismatchError',
    })
    expect(editor.received).toEqual([])
  })

  it('探测握手只读取实例身份，不允许发业务请求', async () => {
    const editor = await fakeEditor()
    const bridge = bridgeFor(editor.pid, { clientKind: 'mcp-probe' })
    await bridge.start()
    expect(bridge.identity).toEqual(editor.identity)
    await expect(bridge.sendRequest(EditorMcpMethod.ListTools)).rejects.toThrow(
      '探测连接不能执行请求',
    )
    expect(editor.received).toEqual([])
  })

  it('身份与选择时不符时，不向新实例发请求', async () => {
    const editor = await fakeEditor({ instanceId: 'new-instance' })
    const bridge = bridgeFor(editor.pid, {
      expectedIdentity: { ...editor.identity, InstanceId: 'old-instance' },
    })
    await expect(bridge.start()).rejects.toThrow('实例已变化')
    expect(editor.received).toEqual([])
  })

  it('连接断开后不自动连接原 PID', async () => {
    const editor = await fakeEditor()
    const onDisconnect = vi.fn()
    const bridge = bridgeFor(editor.pid, { onDisconnect })
    await bridge.start()
    expect((await bridge.sendRequest(EditorMcpMethod.ListTools)).Success).toBe(true)
    await bridge.stop()
    await expect(bridge.sendRequest(EditorMcpMethod.CallTool)).rejects.toThrow('需要重新选择实例')
    expect(editor.received).toEqual(['ListTools'])
  })

  it('请求超时后废止整条连接，不重发可能有副作用的调用', async () => {
    const editor = await fakeEditor({ reply: false })
    const onDisconnect = vi.fn()
    const bridge = bridgeFor(editor.pid, { timeoutMs: 20, onDisconnect })
    await bridge.start()
    await expect(bridge.sendRequest(EditorMcpMethod.CallTool)).rejects.toThrow('response timeout')
    expect(onDisconnect).toHaveBeenCalledOnce()
    await expect(bridge.sendRequest(EditorMcpMethod.CallTool)).rejects.toThrow('需要重新选择实例')
    expect(editor.received).toEqual(['CallTool'])
  })
})
