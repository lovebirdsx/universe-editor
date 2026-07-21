import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'

import { encodeFrame, FrameDecoder, FrameProtocolError } from './framing.js'
import {
  EDITOR_MCP_PROTOCOL_VERSION,
  type EditorMcpMethod,
  type EditorMcpResponseEnvelope,
  parseEditorMcpEnvelope,
  serializeEditorMcpEnvelope,
} from './protocol.js'

function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`
}

export function mcpServicePipeName(pid: number | string): string {
  return `universe-editor-mcp-${pid}`
}

export interface EditorBridgeOptions {
  readonly editorPid: number
  readonly timeoutMs: number
  readonly connectTimeoutMs: number
  readonly onLog?: (message: string) => void
}

interface PendingRequest {
  readonly resolve: (value: EditorMcpResponseEnvelope) => void
  readonly reject: (reason?: unknown) => void
  readonly timer: NodeJS.Timeout
}

export class EditorCommandBridge {
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private socket: Socket | undefined
  private readonly decoder = new FrameDecoder()
  private connecting: Promise<Socket> | undefined
  private stopped = false

  constructor(private readonly options: EditorBridgeOptions) {}

  async start(): Promise<void> {
    await this.ensureConnected()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Bridge stopped'))
    }
    this.pendingRequests.clear()

    const socket = this.socket
    this.socket = undefined
    this.connecting = undefined
    socket?.destroy()
  }

  async sendRequest(
    method: EditorMcpMethod,
    params?: Record<string, unknown>,
  ): Promise<EditorMcpResponseEnvelope> {
    const socket = await this.ensureConnected()
    const requestId = randomUUID()
    const request = {
      Type: 'Request' as const,
      RequestId: requestId,
      Method: method,
      ...(params ? { Params: params } : {}),
    }

    const responsePromise = new Promise<EditorMcpResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`UniverseEditor response timeout for ${method}`))
      }, this.options.timeoutMs)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
    })

    try {
      this.writeFrame(socket, serializeEditorMcpEnvelope(request))
    } catch (error) {
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(requestId)
      }
      throw error
    }
    return responsePromise
  }

  private async ensureConnected(): Promise<Socket> {
    if (this.stopped) throw new Error('Bridge stopped')
    if (this.socket && !this.socket.destroyed) return this.socket
    if (this.connecting) return this.connecting

    this.connecting = this.connect()
    try {
      const socket = await this.connecting
      this.socket = socket
      return socket
    } finally {
      this.connecting = undefined
    }
  }

  private async connect(): Promise<Socket> {
    const pipeName = mcpServicePipeName(this.options.editorPid)
    const path = pipePath(pipeName)

    return new Promise<Socket>((resolve, reject) => {
      const socket = connect(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Connect to ${path} timed out`))
      }, this.options.connectTimeoutMs)

      socket.once('connect', () => {
        clearTimeout(timer)
        this.options.onLog?.(`connected pid=${this.options.editorPid} pipe=${pipeName}`)
        this.decoder.reset()
        socket.on('data', (chunk: Buffer) => this.handleData(chunk))
        socket.on('close', () => this.handleClose(socket))
        socket.on('error', () => {})
        void this.handshake(socket).then(
          () => resolve(socket),
          (error: unknown) => {
            socket.destroy()
            reject(error)
          },
        )
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(
          new Error(
            `Failed to connect UniverseEditor MCP pipe ${path}: ${error.message}. ` +
              '请确认目标 UE4Editor.exe 已启动且 EditorMcpService 正在运行。',
          ),
        )
      })
    })
  }

  private handleClose(socket: Socket): void {
    if (this.socket === socket) this.socket = undefined
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('UniverseEditor MCP pipe closed'))
      this.pendingRequests.delete(requestId)
    }
  }

  private async handshake(socket: Socket): Promise<void> {
    const requestId = randomUUID()
    const responsePromise = new Promise<EditorMcpResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('UniverseEditor v2 handshake timeout'))
      }, this.options.connectTimeoutMs)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
    })

    this.writeFrame(
      socket,
      serializeEditorMcpEnvelope({
        Type: 'Handshake',
        RequestId: requestId,
        ProtocolVersion: EDITOR_MCP_PROTOCOL_VERSION,
        ClientKind: 'mcp-tool',
        ClientName: 'universe-editor-mcp-bridge',
        Capabilities: [],
      }),
    )

    const response = await responsePromise
    if (!response.Success) {
      throw new Error(
        `UniverseEditor v2 handshake failed: ${response.Error?.Code}: ${response.Error?.Message}`,
      )
    }
    const result = response.Result as { ProtocolVersion?: unknown } | undefined
    if (result?.ProtocolVersion !== EDITOR_MCP_PROTOCOL_VERSION) {
      throw new Error('UniverseEditor v2 handshake returned an invalid protocol version')
    }
  }

  private writeFrame(socket: Socket, line: string): void {
    socket.write(encodeFrame(line))
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const line of this.decoder.push(chunk)) {
        this.handleResponseLine(line)
      }
    } catch (error) {
      if (error instanceof FrameProtocolError) {
        this.socket?.destroy(error)
        return
      }
      throw error
    }
  }

  private handleResponseLine(line: string): void {
    const parsed = parseEditorMcpEnvelope(line)
    if (!parsed.ok) {
      this.socket?.destroy(new Error(`${parsed.error.Code}: ${parsed.error.Message}`))
      return
    }
    if (parsed.value.Type === 'Notification') {
      this.options.onLog?.(
        `notification event=${parsed.value.Event} sequence=${parsed.value.Sequence}`,
      )
      return
    }
    if (parsed.value.Type !== 'Response') {
      this.socket?.destroy(
        new Error(`Unexpected ${parsed.value.Type} envelope from UniverseEditor`),
      )
      return
    }

    const pending = this.pendingRequests.get(parsed.value.RequestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(parsed.value.RequestId)
    pending.resolve(parsed.value)
  }
}
