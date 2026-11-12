/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HTTP + WebSocket front door for the phone gateway. One port carries the
 *  pairing API, the PWA static assets and the `/ws` upgrade. The HTTP server is
 *  Node's own (no framework); WebSocket frames use `noServer` so the same
 *  Host/Origin checks guard both transports. No CORS headers are ever emitted.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { ILogger } from '@universe-editor/platform'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_CLIENT_FRAME_BYTES,
  MAX_ID_LENGTH,
  MAX_IMAGE_SRC_LENGTH,
  MAX_MESSAGE_IMAGE_INDEX,
  MOBILE_ATTACHMENT_KIND_HEADER,
  MOBILE_ATTACHMENT_NAME_HEADER,
  MOBILE_ATTACHMENT_PATH_PREFIX,
  MOBILE_ATTACHMENT_UPLOAD_PATH,
  MOBILE_ATTENTION_KINDS,
  MOBILE_CERT_PATH,
  MOBILE_CLOSE_CODES,
  MOBILE_DRAFT_IMAGE_PATH,
  MOBILE_HEALTH_PATH,
  MOBILE_PAIR_PATH,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_SESSION_FILE_PATH,
  MOBILE_SESSION_IMAGE_PATH,
  MOBILE_WS_PATH,
  isMobileAttachmentKind,
  isPreviewableImageMimeType,
  parseClientFrame,
  parsePairRequest,
  serializeFrame,
  type MobileNotificationPrefs,
  type MobileSessionRef,
  type PairResponse,
  type PushSubscribeFrame,
  type ServerFrame,
  type SetNotificationPrefsFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { AuditLog } from './auditLog.js'
import {
  DeviceLimitError,
  type DeviceStore,
  type MobileNotificationPrefsRecord,
} from './deviceStore.js'
import { HelloFailureLimiter } from './helloFailureLimiter.js'
import type { MobileGatewayHub, MobileGatewayHubConnection } from './mobileGatewayHub.js'
import {
  MobileAttachmentError,
  normalizeAttachmentMimeType,
  type MobileGatewayAttachmentHttpStore,
} from './mobileAttachmentStore.js'
import type { PairingService } from './pairingService.js'
import { isAllowedPushEndpoint } from './pushEndpoint.js'
import { checkRequestHeaders } from './requestSecurity.js'
import {
  contentTypeFor,
  isNoCacheAsset,
  NOT_BUILT_PAGE,
  readWebBuildId,
  resolveStaticPath,
} from './staticAssets.js'

export const HELLO_TIMEOUT_MS = 5_000
export const HEARTBEAT_INTERVAL_MS = 25_000
export const HEARTBEAT_TIMEOUT_MS = 60_000
export const MAX_CONNECTIONS_PER_DEVICE = 4
/** Global socket cap, independent of which devices are connected. */
export const MAX_TOTAL_CONNECTIONS = 64
export const MAX_PAIR_BODY_BYTES = 4 * 1024

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self' blob: ws: wss:; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
const POLICY_VIOLATION_CLOSE = 1008
const HSTS_VALUE = 'max-age=31536000'
/** One diagnostic audit entry per reason/address per minute; retries are chatty. */
const DIAGNOSTIC_AUDIT_INTERVAL_MS = 60_000
const MAX_DIAGNOSTIC_AUDIT_KEYS = 256
/** TLS error messages can embed a cert chain; keep the audit detail bounded. */
const MAX_DIAGNOSTIC_DETAIL_LENGTH = 240

export interface MobileGatewayTlsOptions {
  readonly cert: string
  readonly key: string
}

/** Failures that happen before HTTP request routing (TLS / WS upgrade). */
export interface MobileGatewayDiagnosticEvent {
  readonly action: 'tls_handshake_failed' | 'upgrade_rejected'
  readonly remoteAddress: string
  readonly detail: string
}

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
  /**
   * Entry script currently served from `assetsDir`, advertised in `hello_ok`
   * so an already-open PWA can detect a rebuild. Overridable for tests.
   */
  readonly resolveWebBuildId?: () => Promise<string | undefined>
  /** LAN tier: serve HTTPS with the gateway-managed certificate pair. */
  readonly tls?: MobileGatewayTlsOptions
  /**
   * Root CA in PEM (root-ca mode). Enables `GET /api/cert` so a phone can
   * install the trust anchor; never exposed when `tls` is absent.
   */
  readonly caCertificate?: string
  /** Notified for failures recorded in the audit; the host service turns them into UI state. */
  readonly onDiagnostic?: (event: MobileGatewayDiagnosticEvent) => void
  readonly helloTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly heartbeatTimeoutMs?: number
  /** Overridable for tests; defaults to MAX_TOTAL_CONNECTIONS. */
  readonly maxTotalConnections?: number
  readonly helloFailureLimiter?: HelloFailureLimiter
  readonly onConnectionsChanged?: () => void
  /** Fired after push subscription / notification preference changes. */
  readonly onNotificationStateChanged?: () => void
  /** VAPID public key advertised in `hello_ok`; omitted when push is unavailable. */
  readonly vapidPublicKey?: string
  /** Overridable for tests; defaults to the built-in push-service allow-list. */
  readonly isPushEndpointAllowed?: (endpoint: string) => boolean
  /** M2 aggregation; absent in M1-only tests, which keep the empty inbox answer. */
  readonly hub?: MobileGatewayHub
  /** Attachment upload/download store; absent when the gateway runs without files. */
  readonly attachments?: MobileGatewayAttachmentHttpStore
}

interface ConnectionState {
  readonly ws: WebSocket
  readonly remoteAddress: string
  deviceId: string | undefined
  deviceName: string | undefined
  /** Declared by the client on `visibilitychange`; gates in-app notifications. */
  visible: boolean
  helloReceived: boolean
  helloInFlight: boolean
  helloTimer: ReturnType<typeof setTimeout> | undefined
  lastPongAt: number
  readonly hubConnection: MobileGatewayHubConnection | undefined
}

export class MobileGatewayServer {
  private _httpServer: Server | HttpsServer | undefined
  private _wss: WebSocketServer | undefined
  private _heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly _connections = new Set<ConnectionState>()
  private _allowedHosts: readonly string[]
  private _stopping = false
  private _port = 0
  private readonly _helloFailures: HelloFailureLimiter
  private readonly _diagnosticAuditAt = new Map<string, number>()
  private readonly _resolveWebBuildId: () => Promise<string | undefined>

  constructor(private readonly _options: MobileGatewayServerOptions) {
    this._allowedHosts = this._options.allowedHosts
    this._helloFailures = this._options.helloFailureLimiter ?? new HelloFailureLimiter()
    this._resolveWebBuildId =
      this._options.resolveWebBuildId ?? (() => readWebBuildId(this._options.assetsDir))
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

  /** True when this device has at least one foreground-declaring connection. */
  isDeviceVisible(deviceId: string): boolean {
    for (const connection of this._connections) {
      if (connection.deviceId === deviceId && connection.helloReceived && connection.visible) {
        return true
      }
    }
    return false
  }

  /**
   * Send a foreground notification to every visible connection of the device.
   * Returns false when the device has no visible connection (the router then
   * falls back to Web Push).
   */
  sendToVisibleDevices(deviceId: string, frame: ServerFrame): boolean {
    let sent = false
    for (const connection of this._connections) {
      if (connection.deviceId !== deviceId || !connection.helloReceived || !connection.visible) {
        continue
      }
      this._sendFrame(connection.ws, frame)
      sent = true
    }
    return sent
  }

  async start(): Promise<{ readonly port: number }> {
    if (this._httpServer !== undefined) throw new Error('mobile gateway server already started')

    const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
      void this._handleHttp(req, res).catch((err) => {
        this._options.logger.error('mobile gateway HTTP handler failed', err)
        if (!res.headersSent) this._sendText(res, 500, 'Internal Server Error')
        else res.end()
      })
    }
    const tls = this._options.tls
    const httpServer: Server | HttpsServer =
      tls === undefined
        ? createServer(requestHandler)
        : createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, requestHandler)
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    })
    wss.on('error', (err) => this._options.logger.error('mobile gateway websocket error', err))
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
    httpServer.on('clientError', (err, socket) => {
      this._options.logger.debug(
        `mobile gateway client error: ${(err as NodeJS.ErrnoException).code ?? 'unknown'} ${err.message}`,
      )
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    if (tls !== undefined) {
      // Without this listener a TLS failure is completely invisible: the phone
      // never reaches HTTP, so neither the access route nor `hello` can log it.
      ;(httpServer as HttpsServer).on('tlsClientError', (err, tlsSocket) => {
        this._recordDiagnostic(
          tlsSocket.remoteAddress ?? '',
          'tls_handshake_failed',
          `${(err as NodeJS.ErrnoException).code ?? 'unknown'}: ${err.message}`,
        )
      })
    }

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
      `listening on ${this._options.tls === undefined ? 'http' : 'https'}://${this._options.host}:${this._port} allowedHosts=${this._allowedHosts.join(',')}`,
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
    this._diagnosticAuditAt.clear()
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

    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid')
    } catch {
      this._sendText(res, 400, 'Bad Request')
      return
    }
    const pathname = url.pathname

    if (pathname === MOBILE_HEALTH_PATH) {
      this._handleHealth(req, res)
      return
    }
    if (pathname === MOBILE_CERT_PATH) {
      this._handleCertificate(req, res)
      return
    }
    if (pathname === MOBILE_PAIR_PATH) {
      await this._handlePair(req, res)
      return
    }
    if (pathname === MOBILE_ATTACHMENT_UPLOAD_PATH) {
      await this._handleAttachmentUpload(req, res)
      return
    }
    if (pathname.startsWith(MOBILE_ATTACHMENT_PATH_PREFIX)) {
      await this._handleAttachmentDownload(
        req,
        res,
        pathname.slice(MOBILE_ATTACHMENT_PATH_PREFIX.length),
      )
      return
    }
    if (pathname === MOBILE_SESSION_IMAGE_PATH) {
      await this._handleSessionImage(req, res, url.searchParams)
      return
    }
    if (pathname === MOBILE_DRAFT_IMAGE_PATH) {
      await this._handleDraftImage(req, res, url.searchParams)
      return
    }
    if (pathname === MOBILE_SESSION_FILE_PATH) {
      await this._handleSessionWorkspaceImage(req, res, url.searchParams)
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

  /**
   * Unauthenticated same-origin probe the phone uses to tell "the PC is
   * unreachable" apart from "the PC is reachable but the WebSocket is rejected".
   * Host/Origin checks still apply; it exposes no device or session data.
   */
  private _handleHealth(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }
    this._sendJson(
      res,
      200,
      {
        status: 'ok',
        serverVersion: this._options.serverVersion,
        protocolVersion: MOBILE_PROTOCOL_VERSION,
      },
      req.method === 'HEAD',
    )
  }

  /**
   * Root CA download for the phone's trust store. Served only when the gateway
   * actually runs root-ca mode over TLS; Host/Origin checks already ran.
   */
  private _handleCertificate(req: IncomingMessage, res: ServerResponse): void {
    if (this._options.tls === undefined || this._options.caCertificate === undefined) {
      this._sendJson(res, 404, { code: 'not_supported', message: 'root CA is not enabled' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }
    let der: Buffer
    try {
      der = new X509Certificate(this._options.caCertificate).raw
    } catch {
      this._sendJson(res, 500, { code: 'internal', message: 'root CA is unreadable' })
      return
    }
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-x509-ca-cert')
    res.setHeader('Content-Disposition', 'attachment; filename="universe-editor-root-ca.cer"')
    res.setHeader('Content-Length', der.byteLength)
    if (req.method === 'HEAD') res.end()
    else res.end(der)
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
      if (err instanceof DeviceLimitError) {
        await this._audit(remoteAddress, 'pair_attempt', 'failure', 'paired device limit reached')
        this._sendJson(res, 429, { code: 'rate_limited', message: 'paired device limit reached' })
        return
      }
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

  private async _authenticateDevice(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<string | undefined> {
    const header = req.headers.authorization
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token === '') {
      this._sendJson(res, 401, {
        code: 'unauthorized',
        message: 'valid device token required',
      })
      return undefined
    }
    const device = await this._options.store.verify(token)
    if (device === undefined) {
      this._sendJson(res, 401, {
        code: 'unauthorized',
        message: 'valid device token required',
      })
      return undefined
    }
    return device.deviceId
  }

  private async _handleAttachmentUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deviceId = await this._authenticateDevice(req, res)
    if (deviceId === undefined) return
    const attachments = this._options.attachments
    if (attachments === undefined) {
      this._sendJson(res, 404, {
        code: 'not_supported',
        message: 'attachments are not available',
      })
      return
    }
    if (req.method !== 'POST') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'POST' })
      return
    }
    const kind = headerValue(req.headers[MOBILE_ATTACHMENT_KIND_HEADER])
    if (!isMobileAttachmentKind(kind)) {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid attachment kind' })
      return
    }
    const encodedName = headerValue(req.headers[MOBILE_ATTACHMENT_NAME_HEADER])
    if (encodedName === undefined) {
      this._sendJson(res, 400, { code: 'bad_request', message: 'attachment name is required' })
      return
    }
    let name: string
    try {
      name = decodeURIComponent(encodedName)
    } catch {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid attachment name' })
      return
    }
    if (name.trim() === '') {
      this._sendJson(res, 400, { code: 'bad_request', message: 'attachment name is required' })
      return
    }
    const body = await readBodyBytes(req, MAX_ATTACHMENT_UPLOAD_BYTES)
    if (!body.ok) {
      this._sendJson(res, 413, { code: 'bad_request', message: 'attachment is too large' })
      return
    }
    const contentType = headerValue(req.headers['content-type'])?.split(';')[0]
    const mimeType = normalizeAttachmentMimeType(contentType)
    try {
      const result = await attachments.save({
        deviceId,
        kind,
        name,
        mimeType,
        bytes: body.bytes,
      })
      this._sendJson(res, 200, result)
    } catch (err) {
      if (err instanceof MobileAttachmentError) {
        this._sendJson(res, err.code === 'rate_limited' ? 429 : 400, {
          code: err.code,
          message: err.message,
        })
        return
      }
      this._options.logger.error('attachment upload failed', err)
      this._sendJson(res, 500, { code: 'internal', message: 'failed to store attachment' })
    }
  }

  private async _handleAttachmentDownload(
    req: IncomingMessage,
    res: ServerResponse,
    rawId: string,
  ): Promise<void> {
    const deviceId = await this._authenticateDevice(req, res)
    if (deviceId === undefined) return
    const attachments = this._options.attachments
    if (attachments === undefined) {
      this._sendJson(res, 404, {
        code: 'not_supported',
        message: 'attachments are not available',
      })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this._sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }
    let id: string
    try {
      id = decodeURIComponent(rawId)
    } catch {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid attachment id' })
      return
    }
    if (id === '' || id.includes('/')) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'attachment is not available',
      })
      return
    }
    const entry = await attachments.open(deviceId, id)
    if (entry === undefined) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'attachment is not available',
      })
      return
    }
    let bytes: Buffer
    try {
      bytes = await readFile(entry.path)
    } catch {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'attachment is not available',
      })
      return
    }
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = 200
    res.setHeader('Content-Type', entry.mimeType)
    res.setHeader('Content-Length', bytes.byteLength)
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeRfc5987(entry.name)}`)
    if (req.method === 'HEAD') res.end()
    else res.end(bytes)
  }

  /**
   * Image bytes for one ACP image block. The phone learns `index` from the
   * timeline metadata; bytes never travel over the WebSocket because the server
   * frame cap is far below the ACP image cap.
   */
  private async _handleSessionImage(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
  ): Promise<void> {
    const deviceId = await this._authenticateDevice(req, res)
    if (deviceId === undefined) return
    if (!this._allowImageRead(req, res)) return
    const hub = this._options.hub
    if (hub === undefined) {
      this._sendJson(res, 404, { code: 'not_supported', message: 'image api is unavailable' })
      return
    }
    const ref = sessionRefFromQuery(params)
    const messageId = params.get('message') ?? ''
    const index = integerParam(params, 'index')
    if (
      ref === undefined ||
      messageId === '' ||
      messageId.length > MAX_ID_LENGTH ||
      index === undefined ||
      index < 0 ||
      index > MAX_MESSAGE_IMAGE_INDEX
    ) {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid image request' })
      return
    }
    const image = await hub.readSessionImage(ref, messageId, index)
    if (image === undefined) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'image is not available',
      })
      return
    }
    this._sendImage(req, res, image.mimeType, image.bytes)
  }

  /** Preview bytes for an image the PC pasted into the shared draft. */
  private async _handleDraftImage(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
  ): Promise<void> {
    const deviceId = await this._authenticateDevice(req, res)
    if (deviceId === undefined) return
    if (!this._allowImageRead(req, res)) return
    const hub = this._options.hub
    if (hub === undefined) {
      this._sendJson(res, 404, { code: 'not_supported', message: 'image api is unavailable' })
      return
    }
    const ref = sessionRefFromQuery(params)
    const imageId = params.get('image') ?? ''
    if (ref === undefined || imageId === '' || imageId.length > MAX_ID_LENGTH) {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid draft image request' })
      return
    }
    const image = await hub.readDraftImage(ref, imageId)
    if (image === undefined) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'image is not available',
      })
      return
    }
    this._sendImage(req, res, image.mimeType, image.bytes)
  }

  /** Image bytes for a markdown-referenced workspace file (confined to the session cwd). */
  private async _handleSessionWorkspaceImage(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
  ): Promise<void> {
    const deviceId = await this._authenticateDevice(req, res)
    if (deviceId === undefined) return
    if (!this._allowImageRead(req, res)) return
    const hub = this._options.hub
    if (hub === undefined) {
      this._sendJson(res, 404, { code: 'not_supported', message: 'image api is unavailable' })
      return
    }
    const ref = sessionRefFromQuery(params)
    const src = params.get('path') ?? ''
    if (ref === undefined || src === '' || src.length > MAX_IMAGE_SRC_LENGTH) {
      this._sendJson(res, 400, { code: 'bad_request', message: 'invalid image path' })
      return
    }
    const image = await hub.readSessionWorkspaceImage(ref, src)
    if (image === undefined) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'image is not available',
      })
      return
    }
    this._sendImage(req, res, image.mimeType, image.bytes)
  }

  private _allowImageRead(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    this._sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
    return false
  }

  private _sendImage(
    req: IncomingMessage,
    res: ServerResponse,
    mimeType: string,
    bytes: Uint8Array,
  ): void {
    const normalized = mimeType.toLowerCase()
    if (!isPreviewableImageMimeType(normalized)) {
      this._sendJson(res, 404, {
        code: 'attachment_not_found',
        message: 'image is not available',
      })
      return
    }
    const body = Buffer.from(bytes)
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = 200
    res.setHeader('Content-Type', normalized)
    res.setHeader('Content-Length', body.byteLength)
    res.setHeader('Content-Disposition', `inline; filename="image.${imageExtension(normalized)}"`)
    if (req.method === 'HEAD') res.end()
    else res.end(body)
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
      this._rejectUpgrade(req, socket, 503, 'Service Unavailable', 'server_not_ready')
      return
    }
    const check = checkRequestHeaders(
      { host: req.headers.host, origin: req.headers.origin },
      this._allowedHosts,
    )
    if (!check.ok) {
      this._rejectUpgrade(req, socket, 403, 'Forbidden', check.reason)
      return
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    } catch {
      this._rejectUpgrade(req, socket, 400, 'Bad Request', 'bad_url')
      return
    }
    if (pathname !== MOBILE_WS_PATH) {
      this._rejectUpgrade(req, socket, 404, 'Not Found', 'bad_path')
      return
    }
    // Reject before the upgrade handshake so a blocked address never gets a socket.
    if (this._connections.size >= (this._options.maxTotalConnections ?? MAX_TOTAL_CONNECTIONS)) {
      this._rejectUpgrade(req, socket, 503, 'Too Many Connections', 'connection_limit')
      return
    }
    if (this._helloFailures.isBlocked(req.socket.remoteAddress ?? '')) {
      this._rejectUpgrade(req, socket, 429, 'Too Many Requests', 'hello_rate_limited')
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
    const hubConnection =
      this._options.hub === undefined
        ? undefined
        : {
            send: (frame: ServerFrame) => this._sendFrame(ws, frame),
            bufferedAmount: () => ws.bufferedAmount,
          }
    const connection: ConnectionState = {
      ws,
      remoteAddress: req.socket.remoteAddress ?? '',
      deviceId: undefined,
      deviceName: undefined,
      visible: false,
      helloReceived: false,
      helloInFlight: false,
      helloTimer: undefined,
      lastPongAt: Date.now(),
      hubConnection,
    }
    if (hubConnection !== undefined) this._options.hub?.addConnection(hubConnection)
    this._connections.add(connection)
    const timeout = this._options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    connection.helloTimer = setTimeout(() => {
      if (connection.helloReceived) return
      void this._recordHelloFailure(connection, 'hello timeout')
      this._close(connection, MOBILE_CLOSE_CODES.HELLO_TIMEOUT, 'hello timeout')
    }, timeout)
    connection.helloTimer.unref?.()

    ws.on('message', (data, isBinary) => {
      void this._handleMessage(connection, data, isBinary).catch((err) => {
        // An audit/store write can fail (disk full, userData removed); letting it
        // reject unhandled would take down the main process.
        this._options.logger.error('mobile gateway message handler failed', err)
      })
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
        if (connection.hubConnection === undefined) {
          this._sendFrame(connection.ws, { type: 'inbox_snapshot', seq: 0, sessions: [] })
        } else {
          this._options.hub?.subscribeInbox(connection.hubConnection)
        }
        break
      case 'unsubscribe_inbox':
        if (connection.hubConnection !== undefined) {
          this._options.hub?.unsubscribeInbox(connection.hubConnection)
        }
        break
      case 'subscribe_session':
        if (connection.hubConnection === undefined) {
          this._sendServerError(connection.ws, 'not_supported', 'session mirroring is unavailable')
        } else {
          void this._options.hub
            ?.subscribeSession(connection.hubConnection, parsed.value.ref)
            .catch((err) =>
              this._options.logger.warn(`mobile session subscribe failed: ${String(err)}`),
            )
        }
        break
      case 'unsubscribe_session':
        if (connection.hubConnection !== undefined) {
          this._options.hub?.unsubscribeSession(connection.hubConnection, parsed.value.ref)
        }
        break
      case 'client_state':
        connection.visible = parsed.value.visible
        break
      case 'draft_update':
        if (connection.hubConnection !== undefined) {
          void this._options.hub
            ?.handleDraftUpdate(connection.hubConnection, parsed.value)
            .catch((err) => {
              this._options.logger.warn(`mobile draft update failed: ${String(err)}`)
            })
        }
        break
      case 'push_subscribe':
        await this._handlePushSubscribe(connection, parsed.value)
        break
      case 'push_unsubscribe':
        await this._handlePushUnsubscribe(connection)
        break
      case 'set_notification_prefs':
        await this._handleSetNotificationPrefs(connection, parsed.value)
        break
      case 'command': {
        const command = parsed.value
        if (connection.hubConnection === undefined) {
          this._sendFrame(connection.ws, {
            type: 'command_result',
            requestId: command.requestId,
            ok: false,
            error: 'not_supported',
          })
        } else {
          void this._options.hub
            ?.handleCommand(
              connection.hubConnection,
              command,
              {
                record: (action, result, detail) => {
                  void this._options.audit
                    .append({
                      ...(connection.deviceId !== undefined
                        ? { deviceId: connection.deviceId }
                        : {}),
                      ...(connection.deviceName !== undefined
                        ? { deviceName: connection.deviceName }
                        : {}),
                      remoteAddress: connection.remoteAddress,
                      action,
                      result,
                      ...(detail !== undefined ? { detail } : {}),
                    })
                    .catch((err) =>
                      this._options.logger.warn(`mobile command audit failed: ${String(err)}`),
                    )
                },
              },
              {
                ...(connection.deviceId !== undefined ? { deviceId: connection.deviceId } : {}),
              },
            )
            .catch((err) => {
              // A hub exception must not leave the phone waiting forever.
              this._options.logger.warn(`mobile command failed: ${String(err)}`)
              this._sendFrame(connection.ws, {
                type: 'command_result',
                requestId: command.requestId,
                ok: false,
                error: 'internal',
              })
            })
        }
        break
      }
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
    connection.helloReceived = true
    connection.lastPongAt = Date.now()
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer)
      connection.helloTimer = undefined
    }
    // Re-read after verify: a revoke may have landed while this handshake was
    // waiting on the store queue.
    const current = await this._options.store.get(device.deviceId)
    if (current === undefined) {
      await this._recordHelloFailure(connection, 'unauthorized')
      this._close(connection, MOBILE_CLOSE_CODES.UNAUTHORIZED, 'invalid token')
      return
    }
    connection.deviceName = current.name
    if (connection.hubConnection !== undefined) {
      this._options.hub?.authenticateConnection(connection.hubConnection, current.deviceId)
    }
    await this._options.store.touch(current.deviceId)
    const webBuildId = await this._resolveWebBuildId().catch(() => undefined)
    const notificationPrefs =
      current.notifications !== undefined ? wireNotificationPrefs(current.notifications) : undefined
    this._sendFrame(connection.ws, {
      type: 'hello_ok',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: this._options.serverVersion,
      deviceId: current.deviceId,
      serverTime: Date.now(),
      capabilities: [
        'inbox',
        'commands',
        'notifications',
        'history',
        'draft',
        ...(this._options.attachments !== undefined ? ['attachments'] : []),
      ],
      ...(webBuildId !== undefined ? { webBuildId } : {}),
      ...(this._options.vapidPublicKey !== undefined
        ? { vapidPublicKey: this._options.vapidPublicKey }
        : {}),
      ...(notificationPrefs !== undefined ? { notificationPrefs } : {}),
    })
    await this._options.audit.append({
      deviceId: current.deviceId,
      deviceName: current.name,
      remoteAddress: connection.remoteAddress,
      action: 'device_connected',
      result: 'success',
    })
    this._options.logger.info(
      `device connected id=${current.deviceId} name=${current.name} remote=${connection.remoteAddress}`,
    )
    this._options.onConnectionsChanged?.()
  }

  private async _handlePushSubscribe(
    connection: ConnectionState,
    frame: PushSubscribeFrame,
  ): Promise<void> {
    const deviceId = connection.deviceId
    if (deviceId === undefined) return
    const allow = this._options.isPushEndpointAllowed ?? isAllowedPushEndpoint
    if (!allow(frame.subscription.endpoint)) {
      await this._auditDevice(
        connection,
        'push_subscribe',
        'failure',
        'endpoint host is not an allowed push service',
      )
      this._sendServerError(connection.ws, 'bad_request', 'push endpoint is not allowed')
      return
    }
    const stored = await this._options.store.setPushSubscription(deviceId, frame.subscription)
    if (!stored) {
      this._sendServerError(connection.ws, 'unauthorized', 'device is not paired')
      return
    }
    if (frame.prefs !== undefined) {
      await this._options.store.setNotificationPrefs(deviceId, frame.prefs)
    }
    // Audit the host, never the endpoint: push endpoints carry a capability token.
    await this._auditDevice(
      connection,
      'push_subscribe',
      'success',
      `host=${safeHost(frame.subscription.endpoint)}`,
    )
    this._options.onNotificationStateChanged?.()
  }

  private async _handlePushUnsubscribe(connection: ConnectionState): Promise<void> {
    const deviceId = connection.deviceId
    if (deviceId === undefined) return
    const removed = await this._options.store.removePushSubscription(deviceId)
    await this._auditDevice(
      connection,
      'push_unsubscribe',
      removed ? 'success' : 'failure',
      removed ? undefined : 'no stored subscription',
    )
    this._options.onNotificationStateChanged?.()
  }

  private async _handleSetNotificationPrefs(
    connection: ConnectionState,
    frame: SetNotificationPrefsFrame,
  ): Promise<void> {
    const deviceId = connection.deviceId
    if (deviceId === undefined) return
    const stored = await this._options.store.setNotificationPrefs(deviceId, {
      enabled: frame.enabled,
      ...(frame.kinds !== undefined ? { kinds: frame.kinds } : {}),
      alwaysNotify: frame.alwaysNotify ?? false,
    })
    if (!stored) {
      this._sendServerError(connection.ws, 'unauthorized', 'device is not paired')
      return
    }
    this._options.onNotificationStateChanged?.()
  }

  private _handleClose(connection: ConnectionState): void {
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer)
      connection.helloTimer = undefined
    }
    this._connections.delete(connection)
    if (connection.hubConnection !== undefined) {
      this._options.hub?.removeConnection(connection.hubConnection)
    }
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

  private _rejectUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    status: number,
    text: string,
    reason: string,
  ): void {
    this._recordDiagnostic(
      req.socket.remoteAddress ?? '',
      'upgrade_rejected',
      `${reason} status=${status} host=${req.headers.host ?? '-'} origin=${req.headers.origin ?? '-'}`,
    )
    rejectUpgrade(socket, status, text)
  }

  /**
   * Connection failures before `hello` are invisible to the rest of the gateway
   * (TLS handshake, Host/Origin rejection). Record them with a per-reason/address
   * minute bucket so a reconnecting phone cannot flood the audit log.
   */
  private _recordDiagnostic(
    remoteAddress: string,
    action: 'tls_handshake_failed' | 'upgrade_rejected',
    detail: string,
  ): void {
    const normalized =
      detail.length > MAX_DIAGNOSTIC_DETAIL_LENGTH
        ? `${detail.slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH)}…`
        : detail
    const key = `${action}|${remoteAddress}|${normalized}`
    const now = Date.now()
    const last = this._diagnosticAuditAt.get(key)
    if (last !== undefined && now - last < DIAGNOSTIC_AUDIT_INTERVAL_MS) {
      this._options.logger.debug(`${action} ${normalized} remote=${remoteAddress} (suppressed)`)
      return
    }
    if (this._diagnosticAuditAt.size >= MAX_DIAGNOSTIC_AUDIT_KEYS) {
      this._diagnosticAuditAt.clear()
    }
    this._diagnosticAuditAt.set(key, now)
    this._options.logger.warn(`${action} ${normalized} remote=${remoteAddress}`)
    try {
      this._options.onDiagnostic?.({ action, remoteAddress, detail: normalized })
    } catch (err) {
      this._options.logger.warn(`mobile gateway diagnostic listener failed (${action})`, err)
    }
    void this._options.audit
      .append({ remoteAddress, action, result: 'failure', detail: normalized })
      .catch((err) =>
        this._options.logger.error(`mobile gateway audit write failed (${action})`, err),
      )
  }

  private _sendFrame(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(serializeFrame(frame), (err) => {
      if (err) this._options.logger.debug(`websocket send failed: ${err.message}`)
    })
  }

  private _sendServerError(
    ws: WebSocket,
    code: 'bad_request' | 'not_supported' | 'rate_limited' | 'unauthorized',
    message: string,
  ): void {
    this._sendFrame(ws, { type: 'server_error', code, message, retryable: false })
  }

  private _sendJson(res: ServerResponse, status: number, payload: unknown, headOnly = false): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    this._applySecurityHeaders(res, 'no-store')
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', body.byteLength)
    if (headOnly) res.end()
    else res.end(body)
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
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', cacheControl)
    if (this._options.tls !== undefined) {
      res.setHeader('Strict-Transport-Security', HSTS_VALUE)
    }
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

  private _auditDevice(
    connection: ConnectionState,
    action: string,
    result: 'success' | 'failure',
    detail: string | undefined,
  ): Promise<void> {
    return this._options.audit.append({
      ...(connection.deviceId !== undefined ? { deviceId: connection.deviceId } : {}),
      ...(connection.deviceName !== undefined ? { deviceName: connection.deviceName } : {}),
      remoteAddress: connection.remoteAddress,
      action,
      result,
      ...(detail !== undefined ? { detail } : {}),
    })
  }
}

function wireNotificationPrefs(
  stored: MobileNotificationPrefsRecord,
): MobileNotificationPrefs | undefined {
  const kinds = stored.kinds
  // A hand-edited devices.json can carry kinds the phone's strict parser rejects;
  // omit the whole snapshot rather than making hello_ok undecodable.
  if (kinds !== undefined && kinds.some((kind) => !MOBILE_ATTENTION_KINDS.includes(kind))) {
    return undefined
  }
  return {
    enabled: stored.enabled,
    ...(kinds !== undefined ? { kinds } : {}),
    alwaysNotify: stored.alwaysNotify,
  }
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'invalid'
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

interface ReadBytesResult {
  readonly ok: true
  readonly bytes: Buffer
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<ReadBodyResult | { readonly ok: false }> {
  const result = await readBodyBytes(req, limit)
  if (!result.ok) return result
  return { ok: true, text: result.bytes.toString('utf8') }
}

async function readBodyBytes(
  req: IncomingMessage,
  limit: number,
): Promise<ReadBytesResult | { readonly ok: false }> {
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
  return { ok: true, bytes: Buffer.concat(chunks, total) }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sessionRefFromQuery(params: URLSearchParams): MobileSessionRef | undefined {
  const windowId = integerParam(params, 'windowId')
  const localId = params.get('localId') ?? ''
  const durableId = params.get('durableId') ?? undefined
  if (windowId === undefined || windowId < 0) return undefined
  if (localId === '' || localId.length > MAX_ID_LENGTH) return undefined
  if (durableId !== undefined && (durableId === '' || durableId.length > MAX_ID_LENGTH)) {
    return undefined
  }
  return {
    windowId,
    localId,
    ...(durableId !== undefined ? { durableId } : {}),
  }
}

/** Strict query integer: `Number('')` is `0`, which would silently accept a missing param. */
function integerParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name)
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'png'
  }
}

/** RFC 5987 attr-char: encodeURIComponent leaves `'()*` unescaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
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
