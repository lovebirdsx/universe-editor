import { afterEach, describe, expect, it, vi } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, createServer as netServer } from 'node:net'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { NullLogger } from '@universe-editor/platform'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MOBILE_ATTACHMENT_KIND_HEADER,
  MOBILE_ATTACHMENT_NAME_HEADER,
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_SESSION_REPORT_PATH,
  parseServerFrame,
  type PairResponse,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import { AuditLog } from '../auditLog.js'
import { DeviceStore } from '../deviceStore.js'
import { HelloFailureLimiter, MAX_HELLO_FAILURES_PER_ADDRESS } from '../helloFailureLimiter.js'
import { ensureLanCertificate, fingerprintOf } from '../lanCertificate.js'
import { MobileAttachmentStore } from '../mobileAttachmentStore.js'
import { MobileGatewayHub } from '../mobileGatewayHub.js'
import { MobileGatewayServer, type MobileGatewayServerOptions } from '../mobileGatewayServer.js'
import { PairingService } from '../pairingService.js'
import type { SessionReportReadResult } from '../sessionReportReader.js'
import type { MobileBridgeImage } from '../../../../shared/ipc/mobileGatewayService.js'

interface GatewayHarness {
  readonly server: MobileGatewayServer
  readonly store: DeviceStore
  readonly pairing: PairingService
  readonly audit: AuditLog
  readonly base: string
  readonly dir: string
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function startGateway(
  overrides: Partial<MobileGatewayServerOptions> = {},
  options: { assets?: boolean } = {},
): Promise<GatewayHarness> {
  const dir = mkTempDir('ue-mobile-gateway-')
  const assets = join(dir, 'assets')
  await fs.mkdir(assets, { recursive: true })
  if (options.assets !== false) {
    await fs.writeFile(join(assets, 'index.html'), '<html><body>mobile shell</body></html>')
    await fs.writeFile(join(assets, 'sw.js'), 'self.addEventListener("fetch", () => {})')
    await fs.writeFile(join(assets, 'app.js'), 'console.log("app")')
  }
  const store = new DeviceStore(join(dir, 'mobile', 'devices.json'))
  const pairing = new PairingService({ fixedCode: 'ABCD2345' })
  pairing.start()
  const audit = new AuditLog(join(dir, 'mobile', 'audit.jsonl'))
  const server = new MobileGatewayServer({
    host: '127.0.0.1',
    port: 0,
    allowedHosts: [],
    assetsDir: assets,
    store,
    pairing,
    audit,
    logger: new NullLogger(),
    serverVersion: '0.0.0-test',
    ...overrides,
  })
  await server.start()
  cleanup.push(() => {
    removeDirWithRetry(dir)
  })
  cleanup.push(() => server.stop())
  return {
    server,
    store,
    pairing,
    audit,
    dir,
    base: `http://127.0.0.1:${server.port}`,
  }
}

async function pair(base: string, code = 'ABCD2345'): Promise<PairResponse> {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Pixel 9', platform: 'android' }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as PairResponse
}

function connectWs(base: string, origin?: string): Promise<WebSocket> {
  const url = base.replace(/^http/, 'ws') + '/ws'
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function httpsGet(
  port: number,
  path: string,
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** Binary-safe HTTPS request, optionally trusting only the supplied root CA. */
function httpsRequestBuffer(
  port: number,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    ca?: string
    rejectUnauthorized?: boolean
  } = {},
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        rejectUnauthorized: options.rejectUnauthorized ?? false,
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

function nextFrame(ws: WebSocket): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      ws.off('error', onError)
      const parsed = parseServerFrame(data.toString())
      if (!parsed.ok) reject(new Error(`bad server frame: ${parsed.error.message}`))
      else resolve(parsed.value)
    }
    const onError = (error: Error): void => {
      ws.off('message', onMessage)
      reject(error)
    }
    ws.once('message', onMessage)
    ws.once('error', onError)
  })
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

async function hello(ws: WebSocket, token: string, protocolVersion = MOBILE_PROTOCOL_VERSION) {
  const frame = nextFrame(ws)
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion,
      token,
      clientVersion: '0.0.0-test',
      capabilities: [],
    }),
  )
  return frame
}

async function failHello(base: string, token = 'not-a-token'): Promise<number> {
  const ws = await connectWs(base)
  const closed = waitClose(ws)
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token,
      clientVersion: '0.0.0-test',
      capabilities: [],
    }),
  )
  const { code } = await closed
  ws.terminate()
  return code
}

function expectUpgradeRejected(base: string, status: number): Promise<void> {
  const url = base.replace(/^http/, 'ws') + '/ws'
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => {
      ws.terminate()
      reject(new Error('expected the upgrade to be rejected'))
    })
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      const actual = res.statusCode ?? 0
      ws.terminate()
      if (actual === status) resolve()
      else reject(new Error(`expected HTTP ${status}, got ${actual}`))
    })
    ws.once('error', () => {
      // A rejected upgrade may also surface as an error; the promise settles above.
    })
  })
}

function rawRequest(
  base: string,
  path: string,
  options: { method?: string; host?: string; origin?: string } = {},
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: {
          Host: options.host ?? `${url.hostname}:${url.port}`,
          ...(options.origin === undefined ? {} : { Origin: options.origin }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Raw HTTP upgrade attempt; a rejected upgrade replies with the status line. */
function upgradeStatus(
  base: string,
  options: { host?: string; origin?: string } = {},
): Promise<number> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/ws',
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          Host: options.host ?? `${url.hostname}:${url.port}`,
          ...(options.origin === undefined ? {} : { Origin: options.origin }),
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 101)
    })
    req.on('error', reject)
    req.end()
  })
}

/** Reserve an ephemeral port, then release it for the gateway to bind. */
async function freePort(): Promise<number> {
  const server = netServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('mobile gateway server integration', () => {
  it('pairs, greets, answers ping/subscribe, and revokes the device', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    expect(paired.protocolVersion).toBe(MOBILE_PROTOCOL_VERSION)
    expect(paired.pcName).not.toBe('')

    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    const ok = await hello(ws, paired.token)
    expect(ok).toMatchObject({
      type: 'hello_ok',
      deviceId: paired.deviceId,
      serverVersion: '0.0.0-test',
      capabilities: ['inbox', 'commands', 'notifications', 'history', 'draft'],
    })
    expect(ok.type === 'hello_ok' ? ok.serverTime : 0).toBeGreaterThan(0)

    const pong = nextFrame(ws)
    ws.send(JSON.stringify({ type: 'ping', t: 42 }))
    expect(await pong).toEqual({ type: 'pong', t: 42 })

    const snapshot = nextFrame(ws)
    ws.send(JSON.stringify({ type: 'subscribe_inbox' }))
    expect(await snapshot).toEqual({ type: 'inbox_snapshot', seq: 0, sessions: [] })

    const devices = await gateway.store.list()
    expect(devices).toHaveLength(1)
    expect(devices[0]?.lastSeenAt).toBeGreaterThan(0)

    const revoked = nextFrame(ws)
    const closed = waitClose(ws)
    await gateway.store.revoke(paired.deviceId)
    gateway.server.revokeConnections(paired.deviceId)
    expect(await revoked).toEqual({ type: 'device_revoked' })
    expect((await closed).code).toBe(MOBILE_CLOSE_CODES.REVOKED)

    const audit = await gateway.audit.recent(20)
    expect(
      audit.some((entry) => entry.action === 'pair_attempt' && entry.result === 'success'),
    ).toBe(true)
    expect(
      audit.some((entry) => entry.action === 'device_connected' && entry.result === 'success'),
    ).toBe(true)
    expect(JSON.stringify(audit)).not.toContain(paired.token)
    expect(JSON.stringify(audit)).not.toContain('ABCD2345')
  })

  it('advertises the entry script from index.html and re-reads it per hello', async () => {
    const gateway = await startGateway({}, { assets: false })
    const indexPath = join(gateway.dir, 'assets', 'index.html')
    await fs.writeFile(indexPath, '<script type="module" src="/assets/index-old.js"></script>')
    const paired = await pair(gateway.base)

    const first = await connectWs(gateway.base)
    cleanup.push(() => first.terminate())
    expect(await hello(first, paired.token)).toMatchObject({
      type: 'hello_ok',
      webBuildId: 'index-old.js',
    })

    await fs.writeFile(indexPath, '<script src="/assets/index-new.js" type="module"></script>')
    const second = await connectWs(gateway.base)
    cleanup.push(() => second.terminate())
    expect(await hello(second, paired.token)).toMatchObject({
      type: 'hello_ok',
      webBuildId: 'index-new.js',
    })
  })

  it('closes unauthorized, protocol-mismatched and silent clients with the matching codes', async () => {
    const gateway = await startGateway({ helloTimeoutMs: 50 })

    const unauthorized = await connectWs(gateway.base)
    cleanup.push(() => unauthorized.terminate())
    const unauthorizedClose = waitClose(unauthorized)
    unauthorized.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: MOBILE_PROTOCOL_VERSION,
        token: 'not-a-token',
        clientVersion: '0.0.0-test',
        capabilities: [],
      }),
    )
    expect((await unauthorizedClose).code).toBe(MOBILE_CLOSE_CODES.UNAUTHORIZED)

    const mismatch = await connectWs(gateway.base)
    cleanup.push(() => mismatch.terminate())
    const mismatchClose = waitClose(mismatch)
    mismatch.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: MOBILE_PROTOCOL_VERSION + 1,
        token: 'irrelevant',
        clientVersion: '0.0.0-test',
        capabilities: [],
      }),
    )
    expect((await mismatchClose).code).toBe(MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH)

    const silent = await connectWs(gateway.base)
    cleanup.push(() => silent.terminate())
    expect((await waitClose(silent)).code).toBe(MOBILE_CLOSE_CODES.HELLO_TIMEOUT)
  })

  it('serves assets, SPA fallback, security headers and rejects traversal', async () => {
    const gateway = await startGateway()

    const index = await fetch(`${gateway.base}/`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('mobile shell')
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(index.headers.get('x-frame-options')).toBe('DENY')
    expect(index.headers.get('referrer-policy')).toBe('no-referrer')
    expect(index.headers.get('strict-transport-security')).toBeNull()
    expect(index.headers.get('cache-control')).toBe('no-cache')
    expect(index.headers.get('access-control-allow-origin')).toBeNull()

    const asset = await fetch(`${gateway.base}/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=300')

    const fallback = await fetch(`${gateway.base}/session/abc`)
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain('mobile shell')

    for (const path of ['/../secret', '/%2e%2e/secret', '//etc/passwd']) {
      const response = await rawRequest(gateway.base, path)
      expect(response.status, path).toBe(403)
    }
  })

  it('serves the LAN tier over HTTPS with HSTS', async () => {
    const tlsDir = mkTempDir('ue-mobile-tls-')
    cleanup.push(() => {
      removeDirWithRetry(tlsDir)
    })
    const certificate = await ensureLanCertificate({
      dir: tlsDir,
      addresses: ['127.0.0.1'],
    })
    const gateway = await startGateway({
      tls: { cert: certificate.cert, key: certificate.key },
    })

    const index = await httpsGet(gateway.server.port, '/')
    expect(index.status).toBe(200)
    expect(index.body).toContain('mobile shell')
    expect(index.headers['strict-transport-security']).toBe('max-age=31536000')

    const pairResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: '127.0.0.1',
          port: gateway.server.port,
          path: '/api/pair',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      request.on('error', reject)
      request.end(JSON.stringify({ code: 'ABCD2345', deviceName: 'Pixel', platform: 'android' }))
    })
    expect(pairResponse.status).toBe(200)
    expect(JSON.parse(pairResponse.body)).toMatchObject({ pcName: expect.any(String) })
  })

  it('rejects foreign Host headers and cross-origin requests', async () => {
    const gateway = await startGateway()
    expect((await rawRequest(gateway.base, '/', { host: 'evil.example.com' })).status).toBe(403)
    expect(
      (await rawRequest(gateway.base, '/', { origin: 'https://evil.example.com' })).status,
    ).toBe(403)
    expect(
      (
        await rawRequest(gateway.base, '/', {
          origin: `http://127.0.0.1:${gateway.server.port}`,
        })
      ).status,
    ).toBe(200)
  })

  it('serves an unauthenticated health probe without device data', async () => {
    const gateway = await startGateway()
    const response = await fetch(`${gateway.base}/api/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toEqual({
      status: 'ok',
      serverVersion: '0.0.0-test',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
    })

    const head = await fetch(`${gateway.base}/api/health`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const post = await fetch(`${gateway.base}/api/health`, { method: 'POST' })
    expect(post.status).toBe(405)

    const foreign = await rawRequest(gateway.base, '/api/health', { host: 'evil.example.com' })
    expect(foreign.status).toBe(403)
  })

  it('accepts the PC host name with the port when it is allowlisted', async () => {
    const port = await freePort()
    const gateway = await startGateway({
      port,
      allowedHosts: [`desktop-test:${port}`],
    })
    expect(await upgradeStatus(gateway.base, { host: `desktop-test:${port}` })).toBe(101)
  })

  it('audits rejected WebSocket upgrades with the rejection reason', async () => {
    const gateway = await startGateway()
    expect(await upgradeStatus(gateway.base, { host: 'evil.example.com' })).toBe(403)
    await expect
      .poll(async () =>
        (await gateway.audit.recent(20)).filter((entry) => entry.action === 'upgrade_rejected'),
      )
      .toHaveLength(1)
    const [entry] = (await gateway.audit.recent(20)).filter(
      (candidate) => candidate.action === 'upgrade_rejected',
    )
    expect(entry?.result).toBe('failure')
    expect(entry?.detail).toContain('host is not allowed')
  })

  it('audits TLS handshake failures that never reach HTTP', async () => {
    const tlsDir = mkTempDir('ue-mobile-tls-')
    cleanup.push(() => {
      removeDirWithRetry(tlsDir)
    })
    const certificate = await ensureLanCertificate({ dir: tlsDir, addresses: ['127.0.0.1'] })
    const gateway = await startGateway({
      tls: { cert: certificate.cert, key: certificate.key },
    })

    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(gateway.server.port, '127.0.0.1', () => {
        // Plaintext against the TLS port: the handshake fails before HTTP.
        socket.end('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
        resolve()
      })
      socket.on('error', reject)
    })

    await expect
      .poll(async () =>
        (await gateway.audit.recent(20)).filter((entry) => entry.action === 'tls_handshake_failed'),
      )
      .toHaveLength(1)
  })

  describe('root CA mode', () => {
    async function startRootCaGateway() {
      const tlsDir = mkTempDir('ue-mobile-tls-ca-')
      cleanup.push(() => {
        removeDirWithRetry(tlsDir)
      })
      const certificate = await ensureLanCertificate({
        dir: tlsDir,
        addresses: ['127.0.0.1'],
        mode: 'root-ca',
      })
      expect(certificate.ca).toBeDefined()
      const onDiagnostic = vi.fn()
      const gateway = await startGateway({
        tls: { cert: certificate.cert, key: certificate.key },
        caCertificate: certificate.ca!.cert,
        onDiagnostic,
      })
      return { gateway, certificate, ca: certificate.ca!, onDiagnostic }
    }

    it('serves the root CA as DER and hides it without root-ca mode', async () => {
      const plain = await startGateway()
      expect((await fetch(`${plain.base}/api/cert`)).status).toBe(404)

      const { gateway, ca } = await startRootCaGateway()
      const response = await httpsRequestBuffer(gateway.server.port, '/api/cert')
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toContain('application/x-x509-ca-cert')
      expect(response.headers['content-disposition']).toContain('attachment')
      expect(response.headers['cache-control']).toBe('no-store')
      const served = new X509Certificate(response.body)
      expect(served.ca).toBe(true)
      expect(fingerprintOf(served)).toBe(ca.fingerprint)

      const head = await httpsRequestBuffer(gateway.server.port, '/api/cert', { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.body).toHaveLength(0)

      const post = await httpsRequestBuffer(gateway.server.port, '/api/cert', { method: 'POST' })
      expect(post.status).toBe(405)

      const foreign = await httpsRequestBuffer(gateway.server.port, '/api/cert', {
        headers: { Host: 'evil.example.com' },
      })
      expect(foreign.status).toBe(403)
    })

    it('verifies a WSS connection against the downloaded root CA', async () => {
      const { gateway, certificate, onDiagnostic } = await startRootCaGateway()
      const port = gateway.server.port
      const url = `wss://127.0.0.1:${port}/ws`

      await expect(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url)
          ws.once('open', () => {
            ws.terminate()
            resolve('open')
          })
          ws.once('error', reject)
        }),
      ).rejects.toThrow()

      // The rejected handshake must reach the host service, which turns it into
      // the settings-page warning; the phone itself cannot report this layer.
      await vi.waitFor(() => {
        expect(onDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'tls_handshake_failed' }),
        )
      })

      const pairResponse = await httpsRequestBuffer(port, '/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ABCD2345', deviceName: 'Pixel 9', platform: 'android' }),
      })
      expect(pairResponse.status).toBe(200)
      const paired = JSON.parse(pairResponse.body.toString('utf8')) as PairResponse

      const ws = new WebSocket(url, { ca: certificate.ca!.cert })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const frame = await hello(ws, paired.token)
      expect(frame.type).toBe('hello_ok')
      ws.terminate()
    })
  })

  it('shows the not-built page when the asset directory is missing', async () => {
    const gateway = await startGateway({}, { assets: false })
    const response = await fetch(`${gateway.base}/`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('手机端资源未构建')
  })

  it('rejects oversized pairing bodies and invalid codes', async () => {
    const gateway = await startGateway()
    const oversized = await fetch(`${gateway.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(4 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)

    const badCode = await fetch(`${gateway.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZ9999', deviceName: 'Pixel', platform: 'android' }),
    })
    expect(badCode.status).toBe(401)
  })

  it('caps connections per device at four', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const sockets: WebSocket[] = []
    for (let index = 0; index < 4; index += 1) {
      const ws = await connectWs(gateway.base)
      sockets.push(ws)
      cleanup.push(() => ws.terminate())
      expect((await hello(ws, paired.token)).type).toBe('hello_ok')
    }
    const extra = await connectWs(gateway.base)
    cleanup.push(() => extra.terminate())
    const closed = waitClose(extra)
    const frame = await hello(extra, paired.token)
    expect(frame).toMatchObject({ type: 'server_error', code: 'rate_limited' })
    expect((await closed).code).toBe(1008)
  })

  it('caps the total number of sockets', async () => {
    const gateway = await startGateway({ maxTotalConnections: 1 })
    const first = await connectWs(gateway.base)
    cleanup.push(() => first.terminate())
    await expect(connectWs(gateway.base)).rejects.toThrow(/503/u)

    const closed = waitClose(first)
    first.close()
    await closed
    // The server removes the socket on its own `close` event, which can land a
    // tick after the client's under load; poll instead of assuming ordering.
    const next = await vi.waitFor(async () => connectWs(gateway.base))
    cleanup.push(() => next.terminate())
  })

  it('rejects upgrades with HTTP 429 after repeated failed hellos', async () => {
    const gateway = await startGateway()
    for (let index = 0; index < MAX_HELLO_FAILURES_PER_ADDRESS; index += 1) {
      expect(await failHello(gateway.base)).toBe(MOBILE_CLOSE_CODES.UNAUTHORIZED)
    }
    await expectUpgradeRejected(gateway.base, 429)
  })

  it('does not count successful hellos toward the failure limit', async () => {
    const limiter = new HelloFailureLimiter()
    const recordFailure = vi.spyOn(limiter, 'recordFailure')
    const gateway = await startGateway({ helloFailureLimiter: limiter })
    const paired = await pair(gateway.base)
    for (let index = 0; index < MAX_HELLO_FAILURES_PER_ADDRESS + 2; index += 1) {
      const ws = await connectWs(gateway.base)
      expect((await hello(ws, paired.token)).type).toBe('hello_ok')
      const closed = waitClose(ws)
      ws.close()
      await closed
    }
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('merges repeated failed-hello audit entries per address', async () => {
    const gateway = await startGateway()
    for (let index = 0; index < 3; index += 1) await failHello(gateway.base)
    let entries = (await gateway.audit.recent(50)).filter(
      (entry) => entry.action === 'hello_failed',
    )
    expect(entries).toHaveLength(1)

    for (let index = 3; index < MAX_HELLO_FAILURES_PER_ADDRESS; index += 1) {
      await failHello(gateway.base)
    }
    entries = (await gateway.audit.recent(50)).filter((entry) => entry.action === 'hello_failed')
    expect(entries).toHaveLength(2)
    expect(entries[1]?.detail).toContain(`suppressed=${MAX_HELLO_FAILURES_PER_ADDRESS - 2}`)
  })

  it('advertises the VAPID public key and the notifications capability', async () => {
    const gateway = await startGateway({ vapidPublicKey: 'vapid-public-key' })
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())

    const ok = await hello(ws, paired.token)
    expect(ok).toMatchObject({
      type: 'hello_ok',
      capabilities: ['inbox', 'commands', 'notifications', 'history', 'draft'],
      vapidPublicKey: 'vapid-public-key',
    })
  })

  it('stores push subscriptions and notification preferences for the paired device', async () => {
    const changes: number[] = []
    const gateway = await startGateway({ onNotificationStateChanged: () => changes.push(1) })
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    await hello(ws, paired.token)

    ws.send(
      JSON.stringify({
        type: 'push_subscribe',
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/device-token',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
        prefs: { enabled: true, kinds: ['permission', 'completed'], alwaysNotify: true },
      }),
    )
    await expect
      .poll(async () => (await gateway.store.get(paired.deviceId))?.push?.endpoint)
      .toBe('https://fcm.googleapis.com/fcm/send/device-token')

    const stored = await gateway.store.get(paired.deviceId)
    expect(stored?.notifications).toEqual({
      enabled: true,
      kinds: ['permission', 'completed'],
      alwaysNotify: true,
    })
    expect(stored?.push?.keys).toEqual({ p256dh: 'p256dh-key', auth: 'auth-key' })
    expect(changes.length).toBeGreaterThan(0)

    const audit = await gateway.audit.recent(50)
    const subscribe = audit.find((entry) => entry.action === 'push_subscribe')
    expect(subscribe?.result).toBe('success')
    expect(subscribe?.detail).toBe('host=fcm.googleapis.com')
    expect(JSON.stringify(audit)).not.toContain('device-token')

    ws.send(JSON.stringify({ type: 'push_unsubscribe' }))
    await expect.poll(async () => (await gateway.store.get(paired.deviceId))?.push).toBeUndefined()
    const unsubscribe = (await gateway.audit.recent(50)).find(
      (entry) => entry.action === 'push_unsubscribe',
    )
    expect(unsubscribe?.result).toBe('success')
  })

  it('rejects push endpoints outside the known push services', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    await hello(ws, paired.token)

    const error = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'push_subscribe',
        subscription: {
          endpoint: 'https://192.0.2.5/push',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
      }),
    )
    expect(await error).toMatchObject({
      type: 'server_error',
      code: 'bad_request',
      message: 'push endpoint is not allowed',
    })

    expect((await gateway.store.get(paired.deviceId))?.push).toBeUndefined()
    const audit = await gateway.audit.recent(50)
    expect(
      audit.some(
        (entry) =>
          entry.action === 'push_subscribe' &&
          entry.result === 'failure' &&
          entry.detail?.includes('not an allowed push service'),
      ),
    ).toBe(true)
  })

  it('updates notification preferences without a subscription', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    await hello(ws, paired.token)

    ws.send(
      JSON.stringify({
        type: 'set_notification_prefs',
        enabled: true,
        kinds: ['question'],
        alwaysNotify: false,
      }),
    )
    await expect
      .poll(async () => (await gateway.store.get(paired.deviceId))?.notifications)
      .toEqual({ enabled: true, kinds: ['question'], alwaysNotify: false })
  })

  it('returns stored notification preferences in hello_ok', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const first = await connectWs(gateway.base)
    cleanup.push(() => first.terminate())
    expect(await hello(first, paired.token)).not.toHaveProperty('notificationPrefs')

    first.send(
      JSON.stringify({
        type: 'set_notification_prefs',
        enabled: true,
        kinds: ['permission', 'completed'],
        alwaysNotify: true,
      }),
    )
    await expect
      .poll(async () => (await gateway.store.get(paired.deviceId))?.notifications)
      .toEqual({ enabled: true, kinds: ['permission', 'completed'], alwaysNotify: true })

    const second = await connectWs(gateway.base)
    cleanup.push(() => second.terminate())
    expect(await hello(second, paired.token)).toMatchObject({
      type: 'hello_ok',
      notificationPrefs: { enabled: true, kinds: ['permission', 'completed'], alwaysNotify: true },
    })

    first.send(
      JSON.stringify({
        type: 'set_notification_prefs',
        enabled: false,
        kinds: ['question'],
        alwaysNotify: true,
      }),
    )
    await expect
      .poll(async () => (await gateway.store.get(paired.deviceId))?.notifications)
      .toEqual({ enabled: false, kinds: ['question'], alwaysNotify: true })

    const third = await connectWs(gateway.base)
    cleanup.push(() => third.terminate())
    expect(await hello(third, paired.token)).toMatchObject({
      type: 'hello_ok',
      notificationPrefs: { enabled: false, kinds: ['question'], alwaysNotify: true },
    })
  })

  it('tracks the foreground visibility declared by client_state', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    await hello(ws, paired.token)

    ws.send(JSON.stringify({ type: 'client_state', visible: true }))
    await expect.poll(() => gateway.server.isDeviceVisible(paired.deviceId)).toBe(true)

    ws.send(JSON.stringify({ type: 'client_state', visible: false }))
    await expect.poll(() => gateway.server.isDeviceVisible(paired.deviceId)).toBe(false)
  })
})

describe('mobile gateway attachment api', () => {
  async function startWithAttachments(): Promise<{
    gateway: GatewayHarness
    store: MobileAttachmentStore
  }> {
    const dir = mkTempDir('ue-mobile-attachment-store-')
    const store = new MobileAttachmentStore({ rootDir: join(dir, 'attachments') })
    await store.initialize()
    cleanup.push(() => store.dispose())
    cleanup.push(() => {
      removeDirWithRetry(dir)
    })
    const gateway = await startGateway({ attachments: store })
    return { gateway, store }
  }

  function upload(
    base: string,
    token: string,
    kind: string,
    name: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<Response> {
    return fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        [MOBILE_ATTACHMENT_KIND_HEADER]: kind,
        [MOBILE_ATTACHMENT_NAME_HEADER]: encodeURIComponent(name),
        'content-type': mimeType,
      },
      body: bytes,
    })
  }

  it('requires a valid device token', async () => {
    const { gateway } = await startWithAttachments()
    const unauthenticated = await fetch(`${gateway.base}/api/attachments`, { method: 'POST' })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toMatchObject({ code: 'unauthorized' })

    const invalid = await fetch(`${gateway.base}/api/attachments/att-1`, {
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(invalid.status).toBe(401)
  })

  it('uploads and downloads the exact bytes for the owning device', async () => {
    const { gateway } = await startWithAttachments()
    const owner = await pair(gateway.base)
    const other = await pair(gateway.base)
    expect(other.deviceId).not.toBe(owner.deviceId)
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

    const uploaded = await upload(
      gateway.base,
      owner.token,
      'image',
      '截图 1.png',
      bytes,
      'image/png; charset=binary',
    )
    expect(uploaded.status).toBe(200)
    const result = (await uploaded.json()) as {
      id: string
      kind: string
      name: string
      mimeType: string
      size: number
    }
    expect(result).toMatchObject({
      kind: 'image',
      name: '截图 1.png',
      mimeType: 'image/png',
      size: bytes.byteLength,
    })

    const downloaded = await fetch(`${gateway.base}/api/attachments/${result.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('image/png')
    expect(downloaded.headers.get('cache-control')).toBe('no-store')
    expect(downloaded.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('截图 1.png')}`,
    )
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)

    const head = await fetch(`${gateway.base}/api/attachments/${result.id}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${owner.token}` },
    })
    expect(head.status).toBe(200)
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const foreign = await fetch(`${gateway.base}/api/attachments/${result.id}`, {
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ code: 'attachment_not_found' })
  })

  it('rejects invalid kind and name headers', async () => {
    const { gateway } = await startWithAttachments()
    const paired = await pair(gateway.base)

    const badKind = await upload(
      gateway.base,
      paired.token,
      'audio',
      'a.wav',
      new Uint8Array(1),
      'audio/wav',
    )
    expect(badKind.status).toBe(400)
    expect(await badKind.json()).toMatchObject({ code: 'bad_request' })

    const missingName = await fetch(`${gateway.base}/api/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${paired.token}`,
        [MOBILE_ATTACHMENT_KIND_HEADER]: 'file',
        'content-type': 'text/plain',
      },
      body: new Uint8Array(1),
    })
    expect(missingName.status).toBe(400)
  })

  it('returns 413 before reading a body larger than the upload limit', async () => {
    const { gateway } = await startWithAttachments()
    const paired = await pair(gateway.base)
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(new URL(gateway.base).port),
          path: '/api/attachments',
          method: 'POST',
          headers: {
            authorization: `Bearer ${paired.token}`,
            [MOBILE_ATTACHMENT_KIND_HEADER]: 'file',
            [MOBILE_ATTACHMENT_NAME_HEADER]: encodeURIComponent('huge.bin'),
            'content-type': 'application/octet-stream',
            'content-length': String(MAX_ATTACHMENT_UPLOAD_BYTES + 1),
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(413)
  })

  it('advertises attachments only when a store is wired', async () => {
    const { gateway } = await startWithAttachments()
    const paired = await pair(gateway.base)
    const ws = await connectWs(gateway.base)
    cleanup.push(() => ws.terminate())
    const ok = await hello(ws, paired.token)
    expect(ok).toMatchObject({
      type: 'hello_ok',
      capabilities: ['inbox', 'commands', 'notifications', 'history', 'draft', 'attachments'],
    })

    const bare = await startGateway()
    const barePaired = await pair(bare.base)
    const bareWs = await connectWs(bare.base)
    cleanup.push(() => bareWs.terminate())
    const bareOk = await hello(bareWs, barePaired.token)
    expect(bareOk).toMatchObject({
      type: 'hello_ok',
      capabilities: ['inbox', 'commands', 'notifications', 'history', 'draft'],
    })
    const refused = await fetch(`${bare.base}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${barePaired.token}` },
    })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ code: 'not_supported' })
  })

  it('encodes RFC 5987 attr-characters in the download filename', async () => {
    const { gateway } = await startWithAttachments()
    const paired = await pair(gateway.base)
    const uploaded = await upload(
      gateway.base,
      paired.token,
      'file',
      "it's (1).txt",
      new Uint8Array([1]),
      'text/plain',
    )
    expect(uploaded.status).toBe(200)
    const result = (await uploaded.json()) as { id: string }
    const downloaded = await fetch(`${gateway.base}/api/attachments/${result.id}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(downloaded.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''it%27s%20%281%29.txt`,
    )
  })

  it('serves a CSP that allows blob image previews', async () => {
    const { gateway } = await startWithAttachments()
    const response = await fetch(`${gateway.base}/`)
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("img-src 'self' data: blob:")
  })
})

describe('mobile gateway session image api', () => {
  async function startWithImageHub(): Promise<{
    gateway: GatewayHarness
    readSessionImage: ReturnType<typeof vi.fn>
    readSessionWorkspaceImage: ReturnType<typeof vi.fn>
  }> {
    const readSessionImage = vi.fn(async (): Promise<MobileBridgeImage | undefined> => undefined)
    const readSessionWorkspaceImage = vi.fn(
      async (): Promise<MobileBridgeImage | undefined> => undefined,
    )
    const hub = {
      readSessionImage,
      readSessionWorkspaceImage,
    } as unknown as MobileGatewayHub
    const gateway = await startGateway({ hub })
    return { gateway, readSessionImage, readSessionWorkspaceImage }
  }

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

  it('requires a device token and allows only GET/HEAD', async () => {
    const { gateway } = await startWithImageHub()
    const paired = await pair(gateway.base)
    const path = '/api/sessions/image?windowId=1&localId=s1&message=m1&index=0'

    const unauthenticated = await fetch(`${gateway.base}${path}`)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toMatchObject({ code: 'unauthorized' })

    const invalid = await fetch(`${gateway.base}${path}`, {
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(invalid.status).toBe(401)

    const post = await fetch(`${gateway.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(post.status).toBe(405)
  })

  it('rejects malformed image requests', async () => {
    const { gateway } = await startWithImageHub()
    const paired = await pair(gateway.base)
    const auth = { authorization: `Bearer ${paired.token}` }
    for (const path of [
      '/api/sessions/image',
      '/api/sessions/image?windowId=1&localId=s1&message=m1',
      '/api/sessions/image?windowId=1&localId=s1&message=m1&index=-1',
      '/api/sessions/image?windowId=1&localId=s1&message=m1&index=256',
      '/api/sessions/file?windowId=1&localId=s1',
      '/api/sessions/file?windowId=1&localId=s1&path=',
    ]) {
      const response = await fetch(`${gateway.base}${path}`, { headers: auth })
      expect(response.status, path).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'bad_request' })
    }
  })

  it('serves ACP image bytes with no-store and a HEAD variant', async () => {
    const { gateway, readSessionImage } = await startWithImageHub()
    const paired = await pair(gateway.base)
    readSessionImage.mockResolvedValue({ mimeType: 'image/png', bytes })
    const path = '/api/sessions/image?windowId=2&localId=s1&message=m1&index=1'

    const response = await fetch(`${gateway.base}${path}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('inline; filename="image.png"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain(
      "img-src 'self' data: blob: https: http:",
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(readSessionImage).toHaveBeenCalledWith({ windowId: 2, localId: 's1' }, 'm1', 1)

    const head = await fetch(`${gateway.base}${path}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(head.status).toBe(200)
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('serves workspace image paths and hides misses', async () => {
    const { gateway, readSessionWorkspaceImage } = await startWithImageHub()
    const paired = await pair(gateway.base)
    readSessionWorkspaceImage.mockResolvedValueOnce({ mimeType: 'image/jpeg', bytes })
    const base = `${gateway.base}/api/sessions/file?windowId=1&localId=s1`

    const response = await fetch(`${base}&path=${encodeURIComponent('img/a.jpg')}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('content-disposition')).toBe('inline; filename="image.jpg"')
    expect(readSessionWorkspaceImage).toHaveBeenCalledWith(
      { windowId: 1, localId: 's1' },
      'img/a.jpg',
    )

    const missing = await fetch(`${base}&path=${encodeURIComponent('img/missing.jpg')}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'attachment_not_found' })
  })

  it('answers 404 when no hub is wired', async () => {
    const gateway = await startGateway()
    const paired = await pair(gateway.base)
    const response = await fetch(
      `${gateway.base}/api/sessions/image?windowId=1&localId=s1&message=m1&index=0`,
      { headers: { authorization: `Bearer ${paired.token}` } },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'not_supported' })
  })
})

describe('mobile gateway session report api', () => {
  const runId = '123e4567-e89b-42d3-a456-426614174000'
  const report = new TextEncoder().encode('# Report\n\nbody')

  async function startWithReportHub(): Promise<{
    gateway: GatewayHarness
    readSessionReportRunId: ReturnType<typeof vi.fn>
    readReport: ReturnType<typeof vi.fn>
  }> {
    const readSessionReportRunId = vi.fn(async (): Promise<string | undefined> => runId)
    const readReport = vi.fn(
      async (): Promise<SessionReportReadResult> => ({ ok: true, bytes: report }),
    )
    const hub = { readSessionReportRunId } as unknown as MobileGatewayHub
    const gateway = await startGateway({
      hub,
      reports: { read: readReport },
    })
    return { gateway, readSessionReportRunId, readReport }
  }

  it('requires a device token and allows only GET/HEAD', async () => {
    const { gateway } = await startWithReportHub()
    const paired = await pair(gateway.base)
    const path = `${MOBILE_SESSION_REPORT_PATH}?windowId=1&localId=s1`

    const unauthenticated = await fetch(`${gateway.base}${path}`)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toMatchObject({ code: 'unauthorized' })

    const invalid = await fetch(`${gateway.base}${path}`, {
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(invalid.status).toBe(401)

    const post = await fetch(`${gateway.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(post.status).toBe(405)
  })

  it('rejects malformed session refs', async () => {
    const { gateway } = await startWithReportHub()
    const paired = await pair(gateway.base)
    const auth = { authorization: `Bearer ${paired.token}` }
    for (const path of [
      MOBILE_SESSION_REPORT_PATH,
      `${MOBILE_SESSION_REPORT_PATH}?localId=s1`,
      `${MOBILE_SESSION_REPORT_PATH}?windowId=1`,
    ]) {
      const response = await fetch(`${gateway.base}${path}`, { headers: auth })
      expect(response.status, path).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'bad_request' })
    }
  })

  it('serves the report with no-store headers and a HEAD variant', async () => {
    const { gateway, readSessionReportRunId, readReport } = await startWithReportHub()
    const paired = await pair(gateway.base)
    const path = `${MOBILE_SESSION_REPORT_PATH}?windowId=2&localId=s1&durableId=d1`

    const response = await fetch(`${gateway.base}${path}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('content-length')).toBe(String(report.byteLength))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('inline; filename="report.md"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(report)
    expect(readSessionReportRunId).toHaveBeenCalledWith({
      windowId: 2,
      localId: 's1',
      durableId: 'd1',
    })
    expect(readReport).toHaveBeenCalledWith(runId)

    const head = await fetch(`${gateway.base}${path}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('hides sessions without a run and reports that are gone', async () => {
    const { gateway, readSessionReportRunId, readReport } = await startWithReportHub()
    const paired = await pair(gateway.base)
    const path = `${MOBILE_SESSION_REPORT_PATH}?windowId=1&localId=s1`
    const auth = { authorization: `Bearer ${paired.token}` }

    readSessionReportRunId.mockResolvedValueOnce(undefined)
    const noRun = await fetch(`${gateway.base}${path}`, { headers: auth })
    expect(noRun.status).toBe(404)
    expect(await noRun.json()).toMatchObject({ code: 'attachment_not_found' })
    expect(readReport).not.toHaveBeenCalled()

    readReport.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const missing = await fetch(`${gateway.base}${path}`, { headers: auth })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'attachment_not_found' })
  })

  it('answers 413 for reports above the size limit', async () => {
    const { gateway, readReport } = await startWithReportHub()
    const paired = await pair(gateway.base)
    readReport.mockResolvedValueOnce({ ok: false, reason: 'too_large' })

    const response = await fetch(
      `${gateway.base}${MOBILE_SESSION_REPORT_PATH}?windowId=1&localId=s1`,
      { headers: { authorization: `Bearer ${paired.token}` } },
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'bad_request' })
  })

  it('answers 404 when the hub or reader is not wired', async () => {
    const withoutHub = await startGateway({ reports: { read: vi.fn() } })
    const pairedHub = await pair(withoutHub.base)
    const path = `${MOBILE_SESSION_REPORT_PATH}?windowId=1&localId=s1`
    const response = await fetch(`${withoutHub.base}${path}`, {
      headers: { authorization: `Bearer ${pairedHub.token}` },
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'not_supported' })

    const withoutReports = await startGateway({
      hub: { readSessionReportRunId: vi.fn() } as unknown as MobileGatewayHub,
    })
    const second = await pair(withoutReports.base)
    const noReports = await fetch(`${withoutReports.base}${path}`, {
      headers: { authorization: `Bearer ${second.token}` },
    })
    expect(noReports.status).toBe(404)
    expect(await noReports.json()).toMatchObject({ code: 'not_supported' })
  })
})
