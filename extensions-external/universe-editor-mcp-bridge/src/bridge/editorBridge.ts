import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'

import { encodeFrame, FrameDecoder, FrameProtocolError } from './framing.js'
import {
  EDITOR_MCP_PROTOCOL_VERSION,
  EditorMcpClientKind,
  EditorMcpEnvelopeType,
  EditorMcpProtocolErrorCode,
  type EditorMcpInstanceIdentity,
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

export class EditorMcpVersionMismatchError extends Error {
  constructor() {
    super('UniverseEditor 协议不兼容，请更新 UE 和 MCP bridge')
    this.name = 'EditorMcpVersionMismatchError'
  }
}

export interface EditorBridgeOptions {
  readonly editorPid: number
  readonly timeoutMs: number
  readonly connectTimeoutMs: number
  readonly clientKind?: EditorMcpClientKind
  readonly expectedIdentity?: EditorMcpInstanceIdentity
  readonly onDisconnect?: () => void
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
  private connecting: Promise<Socket> | undefined
  private stopped = false
  private disconnected = false
  private instanceIdentity: EditorMcpInstanceIdentity | undefined

  constructor(private readonly options: EditorBridgeOptions) {}

  async start(): Promise<void> {
    await this.ensureConnected()
  }

  get identity(): EditorMcpInstanceIdentity {
    if (!this.instanceIdentity) throw new Error('UniverseEditor 握手尚未完成')
    return this.instanceIdentity
  }

  get isConnected(): boolean {
    return !this.disconnected && !this.stopped && !!this.socket && !this.socket.destroyed
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.invalidate(new Error('Bridge stopped'))
  }

  async sendRequest(
    method: EditorMcpMethod,
    params?: Record<string, unknown>,
  ): Promise<EditorMcpResponseEnvelope> {
    if (this.options.clientKind === EditorMcpClientKind.McpProbe) {
      throw new Error('探测连接不能执行请求')
    }
    const socket = await this.ensureConnected()
    const requestId = randomUUID()
    const request = {
      Type: EditorMcpEnvelopeType.Request,
      RequestId: requestId,
      Method: method,
      ...(params ? { Params: params } : {}),
    }

    const responsePromise = new Promise<EditorMcpResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.invalidate(new Error(`UniverseEditor response timeout for ${method}`))
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
      this.invalidate(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return responsePromise
  }

  private async ensureConnected(): Promise<Socket> {
    if (this.stopped || this.disconnected)
      throw new Error('UniverseEditor 连接已失效，需要重新选择实例')
    if (this.isConnected) return this.socket!
    if (this.connecting) return this.connecting

    this.connecting = this.connect()
    try {
      const socket = await this.connecting
      if (this.stopped || this.disconnected) {
        socket.destroy()
        throw new Error('UniverseEditor 连接已失效')
      }
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
      const decoder = new FrameDecoder()
      let established = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Connect to ${path} timed out`))
      }, this.options.connectTimeoutMs)

      socket.once('connect', () => {
        this.options.onLog?.(`connected pid=${this.options.editorPid} pipe=${pipeName}`)
        this.socket = socket
        socket.on('data', (chunk: Buffer) => this.handleData(socket, decoder, chunk))
        void this.handshake(socket).then(
          (identity) => {
            clearTimeout(timer)
            if (this.stopped || socket.destroyed) {
              reject(new Error('UniverseEditor 握手时连接已关闭'))
              return
            }
            this.instanceIdentity = identity
            established = true
            resolve(socket)
          },
          (error: unknown) => {
            clearTimeout(timer)
            socket.destroy()
            reject(error)
          },
        )
      })
      socket.on('error', (error: Error) => {
        if (established) {
          this.invalidate(error)
          return
        }
        clearTimeout(timer)
        reject(
          new Error(
            `Failed to connect UniverseEditor MCP pipe ${path}: ${error.message}. ` +
              '请确认目标 UE 编辑器已启动且 EditorMcpService 正在运行。',
          ),
        )
      })
      socket.on('close', () => {
        clearTimeout(timer)
        if (!established)
          reject(new Error(`UniverseEditor MCP pipe ${path} closed during handshake`))
        if (this.socket === socket) this.invalidate(new Error('UniverseEditor MCP pipe closed'))
      })
    })
  }

  private invalidate(reason: Error): void {
    if (this.disconnected) return
    this.disconnected = true
    this.socket?.destroy()
    this.socket = undefined
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      this.pendingRequests.delete(requestId)
    }
    if (!this.stopped && this.instanceIdentity) this.options.onDisconnect?.()
  }

  private async handshake(socket: Socket): Promise<EditorMcpInstanceIdentity> {
    const requestId = randomUUID()
    const responsePromise = new Promise<EditorMcpResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('UniverseEditor handshake timeout'))
      }, this.options.connectTimeoutMs)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
    })

    try {
      this.writeFrame(
        socket,
        serializeEditorMcpEnvelope({
          Type: EditorMcpEnvelopeType.Handshake,
          RequestId: requestId,
          ProtocolVersion: EDITOR_MCP_PROTOCOL_VERSION,
          ClientKind: this.options.clientKind ?? EditorMcpClientKind.McpTool,
          ClientName: 'universe-editor-mcp-bridge',
        }),
      )
    } catch (error) {
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(requestId)
      }
      void responsePromise.catch(() => {})
      throw error
    }

    const response = await responsePromise
    if (!response.Success) {
      if (response.Error?.Code === EditorMcpProtocolErrorCode.UnsupportedProtocolVersion) {
        throw new EditorMcpVersionMismatchError()
      }
      throw new Error(
        `UniverseEditor handshake failed: ${response.Error?.Code}: ${response.Error?.Message}`,
      )
    }
    const result = response.Result as
      | ({ ProtocolVersion?: unknown } & Partial<EditorMcpInstanceIdentity>)
      | undefined
    if (result?.ProtocolVersion !== EDITOR_MCP_PROTOCOL_VERSION) {
      throw new EditorMcpVersionMismatchError()
    }
    if (
      result.EditorPid !== this.options.editorPid ||
      typeof result.InstanceId !== 'string' ||
      !result.InstanceId ||
      typeof result.ProjectPath !== 'string' ||
      !result.ProjectPath
    ) {
      throw new Error('UniverseEditor 握手返回的实例身份无效')
    }
    const identity = {
      EditorPid: result.EditorPid,
      InstanceId: result.InstanceId,
      ProjectPath: result.ProjectPath,
    }
    if (
      this.options.expectedIdentity &&
      (identity.InstanceId !== this.options.expectedIdentity.InstanceId ||
        identity.ProjectPath !== this.options.expectedIdentity.ProjectPath)
    ) {
      throw new Error('UniverseEditor 实例已变化，请重新选择')
    }
    return identity
  }

  private writeFrame(socket: Socket, line: string): void {
    socket.write(encodeFrame(line))
  }

  private handleData(socket: Socket, decoder: FrameDecoder, chunk: Buffer): void {
    try {
      for (const line of decoder.push(chunk)) {
        this.handleResponseLine(socket, line)
      }
    } catch (error) {
      if (error instanceof FrameProtocolError) {
        socket.destroy(error)
        return
      }
      throw error
    }
  }

  private handleResponseLine(socket: Socket, line: string): void {
    const parsed = parseEditorMcpEnvelope(line)
    if (!parsed.ok) {
      socket.destroy(new Error(`${parsed.error.Code}: ${parsed.error.Message}`))
      return
    }
    if (parsed.value.Type !== EditorMcpEnvelopeType.Response) {
      socket.destroy(new Error(`Unexpected ${parsed.value.Type} envelope from UniverseEditor`))
      return
    }

    const pending = this.pendingRequests.get(parsed.value.RequestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(parsed.value.RequestId)
    pending.resolve(parsed.value)
  }
}
