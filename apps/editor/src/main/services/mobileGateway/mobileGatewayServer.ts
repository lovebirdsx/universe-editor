/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HTTP + WebSocket front door for the phone gateway. One port carries the
 *  pairing API, the PWA static assets and the `/ws` upgrade. The HTTP server is
 *  Node's own (no framework); WebSocket frames use `noServer` so the same
 *  Host/Origin checks guard both transports. No CORS headers are ever emitted.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { ILogger } from '@universe-editor/platform'
import {
  MAX_CLIENT_FRAME_BYTES,
  MOBILE_CLOSE_CODES,
  MOBILE_PAIR_PATH,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_WS_PATH,
  parseClientFrame,
  parsePairRequest,
  serializeFrame,
  type PairResponse,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { AuditLog } from './auditLog.js'
import type { DeviceStore } from './deviceStore.js'
import { HelloFailureLimiter } from './helloFailureLimiter.js'
import type { PairingService } from './pairingService.js'
import { checkRequestHeaders } from './requestSecurity.js'
import {
  contentTypeFor,
  isNoCacheAsset,
  NOT_BUILT_PAGE,
  resolveStaticPath,
} from './staticAssets.js'

export const HELLO_TIMEOUT_MS = 5_000
export const HEARTBEAT_INTERVAL_MS = 25_000
export const HEARTBEAT_TIMEOUT_MS = 60_000
export const MAX_CONNECTIONS_PER_DEVICE = 4
export const MAX_PAIR_BODY_BYTES = 4 * 1024

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
const POLICY_VIOLATION_CLOSE = 1008

export interface MobileGatewayServerOptions {
  readonly host: string
  readonly port: number
  readonly allowedHosts: readonly string[]
  readonly assetsDir: string
  readonly store: DeviceStore
  readonly pairing: PairingService
  readonly audit: AuditLog
  readonly logger: ILogger
  readonly serverVersion: string
  readonly helloTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly helloFailureLimiter?: HelloFailureLimiter
  readonly onConnectionsChanged?: () => void
}

interface ConnectionState {
  readonly ws: WebSocket
  readonly remoteAddress: string
  deviceId: string | undefined
  deviceName: string | undefined
  helloReceived: boolean
  helloInFlight: boolean
  helloTimer: ReturnType<typeof setTimeout> | undefined
  lastPongAt: number
}

export class MobileGatewayServer {
  private _httpServer: Server | undefined
  private _wss: WebSocketServer | undefined
  private _heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly _connections = new Set<ConnectionState>()
  private _allowedHosts: readonly string[]
  private _stopping = false
  private _port = 0
  private readonly _helloFailures: HelloFailureLimiter

  constructor(private readonly _options: MobileGatewayServerOptions) {
    this._allowedHosts = this._options.allowedHosts
    this._helloFailures = this._options.helloFailureLimiter ?? new HelloFailureLimiter()
  }

  get port(): number {
    return this._port
  }

  get address(): string {
    return `${this._options.host}:${this._port}`
  }

  getConnectedDeviceIds(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const connection of this._connections) {
      if (connection.deviceId !== undefined) ids.add(connection.deviceId)
    }
    return ids
  }

  getConnectedDeviceCount(): number {
    return this.getConnectedDeviceIds().size
  }

  async start(): Promise<{ readonly port: number }> {
    if (this._httpServer !== undefined) throw new Error('mobile gateway server already started')

    const httpServer = createServer((req, res) => {
      void this._handleHttp(req, res).catch((err) => {
        this._options.logger.error('mobile gateway HTTP handler failed', err)
        if (!res.headersSent) this._sendText(res, 500, 'Internal Server Error')
        else res.end()
      })
    })
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    })
    wss.on('error', (err) => this._options.logger.error('mobile gateway websocket error', err))
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
    httpServer.on('clientError', (_err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })

    this._httpServer = httpServer
    this._wss = wss

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          httpServer.off('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          httpServer.off('error', onError)
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen({ host: this._options.host, port: this._options.port })
      })
    } catch (err) {
      this._httpServer = undefined
      this._wss = undefined
      wss.close()
      httpServer.close()
      throw err
    }

    httpServer.on('error', (err) => {
      this._options.logger.error('mobile gateway server error', err)
    })
    const address = httpServer.address()
    this._port = address !== null && typeof address === 'object' ? address.port : this._options.port
    // `port: 0` is used by tests; rebuild the Host allow-list around the actual
    // port instead of the configured one.
    this._allowedHosts = [
      ...new Set([
        ...this._options.allowedHosts,
        `${this._options.host}:${this._port}`,
        `127.0.0.1:${this._port}`,
        `localhost:${this._port}`,
      ]),
    ]

    const interval = this._options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this._heartbeat = setInterval(() => this._heartbeatTick(), interval)
    this._heartbeat.unref?.()
    this._options.logger.info(
      `listening on ${this._options.host}:${this._port} allowedHosts=${this._options.allowedHosts.join(',')}`,
    )
    return { port: this._port }
  }

  async stop(): Promise<void> {
    if (this._httpServer === undefined) return
    this._stopping = true
    if (this._heartbeat !== undefined) {
      clearInterval(this._heartbeat)
      this._heartbeat = undefined
    }
    for (const connection of [...this._connections]) {
      if (connection.helloTimer !== undefined) clearTimeout(connection.helloTimer)
      connection.ws.terminate()
    }
    this._connections.clear()

    const wss = this._wss
    this._wss = undefined
    if (wss !== undefined) {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }

    const httpServer = this._httpServer
    this._httpServer = undefined
    httpServer.closeAllConnections?.()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    this._stopping = false
    this._options.logger.info('stopped')
  }

  /** Push `device_revoked` to every connection of the device, then close them. */
  revokeConnections(deviceId: string): void {
    for (const connection of this._connections) {
      if (connection.deviceId !== deviceId) continue
      this._sendFrame(connection.ws, { type: 'device_revoked' })
      this._close(connection, MOBILE_CLOSE_CODES.REVOKED, 'device revoked')
    }
  }

  // ---- HTTP -----------------------------------------------------------------

  private async _handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = checkRequestHeaders(
      { host: req.headers.host, origin: req.headers.origin },
      this._allowedHosts,
    )
    if (!headers.ok) {
      this._sendText(res, 403, 'Forbidden')
      return
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    } catch {
      this._sendText(res, 400, 'Bad Request')
      return
    }

    if (pathname === MOBILE_PAIR_PATH) {
      await this._handlePair(req, res)
      return
    }
    if (pathname === MOBILE_WS_PATH) {
      this._sendText(res, 426, 'Upgrade Required', { Upgrade: 'websocket' })
      return
    }
    if (pathname.startsWith('/api/')) {
      this._sendJson(res, 404, { code: 'not_supported', message: 'unknown endpoint' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }
    await this._handleStatic(req, res)
  }

  private async _handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'POST' })
      return
    }
    const remoteAddress = req.socket.remoteAddress ?? ''
    const body = await readBody(req, MAX_PAIR_BODY_BYTES)
    if (!body.ok) {
      await this._audit(remoteAddress, 'pair_attempt', 'failure', 'request body too large')
      this._sendJson(res, 413, { code: 'bad_request', message: 'pair request is too large' })
      return
    }

    let json: unknown
    try {
      json = JSON.parse(body.text)
    } catch {
      await this._audit(remoteAddress, 'pair_attempt', 'failure', 'invalid JSON')
      this._sendJson(res, 400, { code: 'bad_request', message: 'pair request must be JSON' })
      return
    }
    const parsed = parsePairRequest(json)
    if (!parsed.ok) {
      await this._audit(remoteAddress, 'pair_attempt', 'failure', parsed.error.message)
      this._sendJson(res, 400, { code: 'bad_request', message: parsed.error.message })
      return
    }

    const redeem = this._options.pairing.redeem(parsed.value.code, remoteAddress)
    if (redeem !== 'ok') {
      await this._audit(remoteAddress, 'pair_attempt', 'failure', redeem)
      if (redeem === 'rate_limited') {
        this._sendJson(res, 429, { code: 'rate_limited', message: 'too many pairing attempts' })
      } else {
        this._sendJson(res, 401, { code: 'unauthorized', message: 'pairing code is not valid' })
      }
      return
    }

    let token: string
    let deviceId: string
    try {
      const added = await this._options.store.add({
        name: parsed.value.deviceName,
        platform: parsed.value.platform,
      })
      token = added.token
      deviceId = added.device.deviceId
      await this._options.audit.append({
        deviceId,
        deviceName: added.device.name,
        remoteAddress,
        action: 'pair_attempt',
        result: 'success',
      })
      this._options.logger.info(
        `paired device id=${deviceId} name=${added.device.name} platform=${added.device.platform}`,
      )
    } catch (err) {
      this._options.logger.error('failed to persist paired device', err)
      await this._audit(remoteAddress, 'pair_attempt', 'failure', 'device store write failed')
      this._sendJson(res, 500, { code: 'internal', message: 'failed to store device' })
      return
    }

    const response: PairResponse = {
      deviceId,
      token,
      pcName: hostname(),
      protocolVersion: MOBILE_PROTOCOL_VERSION,
    }
    this._sendJson(res, 200, response)
  }

  private async _handleStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resolution = resolveStaticPath(this._options.assetsDir, req.url)
    if (resolution.kind === 'forbidden') {
      this._sendText(res, 403, 'Forbidden')
      return
    }

    let filePath: string | undefined
    if (resolution.kind === 'file' && (await isFile(resolution.path))) {
      filePath = resolution.path
    }
    if (filePath === undefined) {
      const index = join(this._options.assetsDir, 'index.html')
      if (!(await isFile(index))) {
        this._sendHtml(res, 503, NOT_BUILT_PAGE)
        return
      }
      filePath = index
    }

    let content: Buffer
    try {
      content = await readFile(filePath)
    } catch {
      this._sendText(res, 404, 'Not Found')
      return
    }
    const cacheControl = isNoCacheAsset(filePath) ? 'no-cache' : 'public, max-age=300'
    this._applySecurityHeaders(res, cacheControl)
    res.statusCode = 200
    res.setHeader('Content-Type', contentTypeFor(filePath))
    res.setHeader('Content-Length', content.byteLength)
    if (req.method === 'HEAD') res.end()
    else res.end(content)
  }

  // ---- WebSocket ------------------------------------------------------------

  private _handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this._stopping || this._wss === undefined || this._httpServer === undefined) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const check = checkRequestHeaders(
      { host: req.headers.host, origin: req.headers.origin },
      this._allowedHosts,
    )
    if (!check.ok) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (pathname !== MOBILE_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    // Reject before the upgrade handshake so a blocked address never gets a socket.
    if (this._helloFailures.isBlocked(req.socket.remoteAddress ?? '')) {
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return
    }
    try {
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._handleConnection(ws, req)
      })
    } catch (err) {
      this._options.logger.error('websocket upgrade failed', err)
      socket.destroy()
    }
  }

  private _handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connection: ConnectionState = {
      ws,
      remoteAddress: req.socket.remoteAddress ?? '',
      deviceId: undefined,
      deviceName: undefined,
      helloReceived: false,
      helloInFlight: false,
      helloTimer: undefined,
      lastPongAt: Date.now(),
    }
    this._connections.add(connection)
    const timeout = this._options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    connection.helloTimer = setTimeout(() => {
      if (connection.helloReceived) return
      void this._recordHelloFailure(connection, 'hello timeout')
      this._close(connection, MOBILE_CLOSE_CODES.HELLO_TIMEOUT, 'hello timeout')
    }, timeout)
    connection.helloTimer.unref?.()

    ws.on('message', (data, isBinary) => {
      void this._handleMessage(connection, data, isBinary)
    })
    ws.on('pong', () => {
      connection.lastPongAt = Date.now()
    })
    ws.on('close', () => this._handleClose(connection))
    ws.on('error', () => {
      // `close` follows; keep the log surface quiet for client disconnects.
    })
  }

  private async _handleMessage(
    connection: ConnectionState,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this._sendServerError(connection.ws, 'bad_request', 'binary frames are not supported')
      return
    }
    const text = rawDataToString(data)
    if (!connection.helloReceived) {
      if (connection.helloInFlight) return
      connection.helloInFlight = true
      try {
        await this._handleHello(connection, text)
      } finally {
        connection.helloInFlight = false
      }
      return
    }

    const parsed = parseClientFrame(text)
    if (!parsed.ok) {
      this._sendServerError(connection.ws, 'bad_request', parsed.error.message)
      return
    }
    switch (parsed.value.type) {
      case 'ping':
        this._sendFrame(connection.ws, { type: 'pong', t: parsed.value.t })
        break
      case 'subscribe_inbox':
        // M1 has no session mirror; the empty snapshot is the honest answer.
        this._sendFrame(connection.ws, { type: 'inbox_snapshot', seq: 0, sessions: [] })
        break
      case 'unsubscribe_inbox':
        break
      default:
        this._sendServerError(connection.ws, 'not_supported', 'frame is not supported yet')
        break
    }
  }

  private async _handleHello(connection: ConnectionState, text: string): Promise<void> {
    const parsed = parseClientFrame(text)
    if (!parsed.ok) {
      await this._recordHelloFailure(connection, parsed.error.code)
      this._close(connection, MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH, parsed.error.message)
      return
    }
    if (parsed.value.type !== 'hello') {
      await this._recordHelloFailure(connection, 'first frame was not hello')
      this._close(connection, MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH, 'first frame must be hello')
      return
    }

    const device = await this._options.store.verify(parsed.value.token)
    if (device === undefined) {
      await this._recordHelloFailure(connection, 'unauthorized')
      this._close(connection, MOBILE_CLOSE_CODES.UNAUTHORIZED, 'invalid token')
      return
    }
    if (connection.ws.readyState !== WebSocket.OPEN) return

    const sameDevice = [...this._connections].filter(
      (entry) => entry.deviceId === device.deviceId,
    ).length
    if (sameDevice >= MAX_CONNECTIONS_PER_DEVICE) {
      this._sendServerError(connection.ws, 'rate_limited', 'too many connections for this device')
      this._close(connection, POLICY_VIOLATION_CLOSE, 'too many connections')
      return
    }

    connection.deviceId = device.deviceId
    connection.deviceName = device.name
    connection.helloReceived = true
    connection.lastPongAt = Date.now()
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer)
      connection.helloTimer = undefined
    }
    await this._options.store.touch(device.deviceId)
    this._sendFrame(connection.ws, {
      type: 'hello_ok',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: this._options.serverVersion,
      deviceId: device.deviceId,
      serverTime: Date.now(),
      capabilities: ['inbox'],
    })
    await this._options.audit.append({
      deviceId: device.deviceId,
      deviceName: device.name,
      remoteAddress: connection.remoteAddress,
      action: 'device_connected',
      result: 'success',
    })
    this._options.logger.info(
      `device connected id=${device.deviceId} name=${device.name} remote=${connection.remoteAddress}`,
    )
    this._options.onConnectionsChanged?.()
  }

  private _handleClose(connection: ConnectionState): void {
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer)
      connection.helloTimer = undefined
    }
    this._connections.delete(connection)
    if (connection.deviceId !== undefined) {
      this._options.logger.info(`device disconnected id=${connection.deviceId}`)
      this._options.onConnectionsChanged?.()
    }
  }

  private _heartbeatTick(): void {
    const now = Date.now()
    const timeout = this._options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    for (const connection of [...this._connections]) {
      if (!connection.helloReceived) continue
      if (now - connection.lastPongAt > timeout) {
        this._options.logger.warn(`heartbeat timeout id=${connection.deviceId ?? 'unknown'}`)
        connection.ws.terminate()
        continue
      }
      if (connection.ws.readyState === WebSocket.OPEN) {
        try {
          connection.ws.ping()
        } catch {
          connection.ws.terminate()
        }
      }
    }
  }

  // ---- helpers --------------------------------------------------------------

  private _close(connection: ConnectionState, code: number, reason: string): void {
    try {
      connection.ws.close(code, reason)
    } catch {
      connection.ws.terminate()
      return
    }
    // A client that never answers the close handshake must not pin the socket.
    const timer = setTimeout(() => {
      if (connection.ws.readyState !== WebSocket.CLOSED) connection.ws.terminate()
    }, 1_000)
    timer.unref?.()
  }

  private _sendFrame(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(serializeFrame(frame), (err) => {
      if (err) this._options.logger.debug(`websocket send failed: ${err.message}`)
    })
  }

  private _sendServerError(
    ws: WebSocket,
    code: 'bad_request' | 'not_supported' | 'rate_limited',
    message: string,
  ): void {
    this._sendFrame(ws, { type: 'server_error', code, message, retryable: false })
  }

  private _sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', body.byteLength)
    res.end(body)
  }

  private _sendText(
    res: ServerResponse,
    status: number,
    text: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const body = Buffer.from(text, 'utf8')
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = status
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Length', body.byteLength)
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
    res.end(body)
  }

  private _sendHtml(
    res: ServerResponse,
    status: number,
    html: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const body = Buffer.from(html, 'utf8')
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Length', body.byteLength)
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
    res.end(body)
  }

  private _applySecurityHeaders(res: ServerResponse, cacheControl: string): void {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', cacheControl)
  }

  /**
   * Count a failed authentication and write at most a first entry plus one
   * summary per window, so a hostile client cannot flood audit.jsonl.
   */
  private async _recordHelloFailure(connection: ConnectionState, detail: string): Promise<void> {
    const decision = this._helloFailures.recordFailure(connection.remoteAddress)
    if (!decision.audit) return
    await this._options.audit.append({
      remoteAddress: connection.remoteAddress,
      action: 'hello_failed',
      result: 'failure',
      detail: decision.suppressed > 0 ? `${detail} (suppressed=${decision.suppressed})` : detail,
    })
  }

  private _audit(
    remoteAddress: string,
    action: string,
    result: 'success' | 'failure',
    detail: string,
  ): Promise<void> {
    return this._options.audit.append({ remoteAddress, action, result, detail })
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

interface ReadBodyResult {
  readonly ok: true
  readonly text: string
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<ReadBodyResult | { readonly ok: false }> {
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > limit) {
      req.resume()
      return { ok: false }
    }
  }
  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > limit) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    if (!tooLarge) chunks.push(buffer)
  }
  if (tooLarge) return { ok: false }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
