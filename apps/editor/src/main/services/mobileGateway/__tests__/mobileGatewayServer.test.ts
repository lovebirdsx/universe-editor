import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { NullLogger } from '@universe-editor/platform'
import {
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  type PairResponse,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import { AuditLog } from '../auditLog.js'
import { DeviceStore } from '../deviceStore.js'
import { HelloFailureLimiter, MAX_HELLO_FAILURES_PER_ADDRESS } from '../helloFailureLimiter.js'
import { MobileGatewayServer, type MobileGatewayServerOptions } from '../mobileGatewayServer.js'
import { PairingService } from '../pairingService.js'

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
      capabilities: ['inbox'],
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
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(index.headers.get('referrer-policy')).toBe('no-referrer')
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
})
