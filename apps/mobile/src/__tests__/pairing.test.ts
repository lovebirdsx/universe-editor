import { describe, expect, it, vi } from 'vitest'
import { guessDevice, requestPair, type PairRequestResult } from '../pairing.js'
import { pairErrorText, strings } from '../strings.js'

describe('guessDevice', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 'ios'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad', 'ios'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Android 手机', 'android'],
    ['Mozilla/5.0 (X11; Linux x86_64)', '手机', 'other'],
  ] as const)('maps %s', (ua, deviceName, platform) => {
    expect(guessDevice(ua)).toEqual({ deviceName, platform })
  })
})

describe('pairErrorText', () => {
  it('maps gateway error codes to Chinese copy', () => {
    expect(pairErrorText('unauthorized')).toBe(strings.pairErrorUnauthorized)
    expect(pairErrorText('expired')).toBe(strings.pairErrorUnauthorized)
    expect(pairErrorText('rate_limited')).toBe(strings.pairErrorRateLimited)
    expect(pairErrorText('bad_request')).toBe(strings.pairErrorBadRequest)
    expect(pairErrorText('network')).toBe(strings.pairErrorNetwork)
    expect(pairErrorText('something_else')).toBe(strings.pairErrorUnknown)
  })
})

describe('requestPair', () => {
  it('posts the normalized request and accepts a pair response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            deviceId: 'device-1',
            token: 'token-1',
            pcName: 'PC-A',
            protocolVersion: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const result: PairRequestResult = await requestPair(
      { code: 'ABCD2345', deviceName: 'Pixel 9', platform: 'android' },
      fetchImpl as unknown as typeof fetch,
    )

    expect(fetchImpl).toHaveBeenCalledWith('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD2345', deviceName: 'Pixel 9', platform: 'android' }),
    })
    expect(result).toEqual({
      ok: true,
      response: {
        deviceId: 'device-1',
        token: 'token-1',
        pcName: 'PC-A',
        protocolVersion: 1,
      },
    })
  })

  it('reports the gateway error code', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'rate_limited', message: 'too many' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(
      requestPair(
        { code: 'ABCD2345', deviceName: 'Pixel 9', platform: 'android' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ ok: false, code: 'rate_limited', network: false })
  })

  it('reports network failures without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(
      requestPair(
        { code: 'ABCD2345', deviceName: 'Pixel 9', platform: 'android' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ ok: false, code: 'network', network: true })
  })
})
