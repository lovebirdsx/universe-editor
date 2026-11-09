import { MOBILE_PROTOCOL_VERSION } from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import { probeGatewayHealth } from '../connectionDiagnosis.js'

const ORIGIN = 'https://192.0.2.10:47321'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function healthy(): Response {
  return jsonResponse({
    status: 'ok',
    serverVersion: '1.2.3',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
  })
}

describe('probeGatewayHealth', () => {
  it('requests the health endpoint without credentials', async () => {
    const fetchImpl = vi.fn(async () => healthy()) as unknown as typeof fetch
    const result = await probeGatewayHealth(`${ORIGIN}/`, { fetchImpl })

    expect(result).toEqual({
      kind: 'ok',
      origin: ORIGIN,
      status: 200,
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: '1.2.3',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ORIGIN}/api/health`,
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit' }),
    )
  })

  it.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'http-error'],
    [503, 'http-error'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    const fetchImpl = (async () => jsonResponse({}, status)) as typeof fetch
    await expect(probeGatewayHealth(ORIGIN, { fetchImpl })).resolves.toMatchObject({ kind, status })
  })

  it('treats a non-JSON body as an unexpected response', async () => {
    const fetchImpl = (async () =>
      new Response('<html>portal</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch
    await expect(probeGatewayHealth(ORIGIN, { fetchImpl })).resolves.toMatchObject({
      kind: 'invalid-response',
    })
  })

  it('treats a JSON body without a protocol version as an unexpected response', async () => {
    const fetchImpl = (async () => jsonResponse({ status: 'ok' })) as typeof fetch
    await expect(probeGatewayHealth(ORIGIN, { fetchImpl })).resolves.toMatchObject({
      kind: 'invalid-response',
    })
  })

  it('reports a protocol mismatch instead of ok', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        status: 'ok',
        serverVersion: '2.0.0',
        protocolVersion: MOBILE_PROTOCOL_VERSION + 1,
      })) as typeof fetch
    await expect(probeGatewayHealth(ORIGIN, { fetchImpl })).resolves.toMatchObject({
      kind: 'protocol-mismatch',
      protocolVersion: MOBILE_PROTOCOL_VERSION + 1,
    })
  })

  it('maps a rejected fetch to network-error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(probeGatewayHealth(ORIGIN, { fetchImpl })).resolves.toEqual({
      kind: 'network-error',
      origin: ORIGIN,
    })
  })

  it('maps a timeout to network-error', async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    await expect(probeGatewayHealth(ORIGIN, { fetchImpl, timeoutMs: 5 })).resolves.toMatchObject({
      kind: 'network-error',
    })
  })
})
