import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SwarmApi,
  SwarmError,
  SwarmErrorCode,
  mapHttpError,
  buildQuery,
  resolveSwarmRequestTimeoutMs,
} from '../swarm/swarmApi.js'

describe('swarmApi.mapHttpError', () => {
  it('maps 401/403 to Unauthorized', () => {
    expect(mapHttpError(401, 'x').code).toBe(SwarmErrorCode.Unauthorized)
    expect(mapHttpError(403, 'x').code).toBe(SwarmErrorCode.Unauthorized)
  })
  it('maps 404 to NotFound', () => {
    expect(mapHttpError(404, 'x').code).toBe(SwarmErrorCode.NotFound)
  })
  it('maps 429 to RateLimited', () => {
    expect(mapHttpError(429, 'x').code).toBe(SwarmErrorCode.RateLimited)
  })
  it('maps 5xx to Server', () => {
    expect(mapHttpError(500, 'x').code).toBe(SwarmErrorCode.Server)
    expect(mapHttpError(503, 'x').code).toBe(SwarmErrorCode.Server)
  })
  it('maps other 4xx to Unknown', () => {
    expect(mapHttpError(400, 'x').code).toBe(SwarmErrorCode.Unknown)
  })
})

describe('swarmApi.buildQuery', () => {
  it('returns empty for no params', () => {
    expect(buildQuery(undefined)).toBe('')
    expect(buildQuery({})).toBe('')
  })
  it('skips undefined values', () => {
    expect(buildQuery({ a: undefined, b: 1 })).toBe('?b=1')
  })
  it('expands arrays to key[]=v pairs', () => {
    expect(buildQuery({ state: ['needsReview', 'approved'] })).toBe(
      '?state[]=needsReview&state[]=approved',
    )
  })
  it('encodes special characters', () => {
    expect(buildQuery({ keywords: 'a b&c' })).toBe('?keywords=a%20b%26c')
  })
})

describe('SwarmApi request', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function api(getAuth: () => Promise<string | undefined> = async () => 'Basic X') {
    return new SwarmApi({ baseUrl: 'https://swarm.example.com/', apiVersion: 'v11', getAuth })
  }

  it('builds the /api/vN/ URL and injects the auth header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reviews: [] }), { status: 200 }))
    await api().get('reviews', { query: { max: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://swarm.example.com/api/v11/reviews?max=1')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Basic X' })
  })

  it('throws Unauthorized when no credential is available', async () => {
    await expect(api(async () => undefined).get('reviews')).rejects.toMatchObject({
      code: SwarmErrorCode.Unauthorized,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a 404 to a SwarmError without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))
    await expect(api().get('reviews/99')).rejects.toMatchObject({ code: SwarmErrorCode.NotFound })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 500 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const res = await api().get<{ ok: boolean }>('reviews')
    expect(res).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends a JSON body on POST', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ review: { id: 1 } }), { status: 200 }),
    )
    await api().post('reviews', { change: '100' })
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe('{"change":"100"}')
    expect((init as RequestInit).headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('surfaces a network rejection as a SwarmError', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(api().get('reviews')).rejects.toBeInstanceOf(SwarmError)
  })
})

describe('resolveSwarmRequestTimeoutMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  it('defaults to 30s', () => {
    expect(resolveSwarmRequestTimeoutMs(undefined)).toBe(30_000)
  })
  it('honours the explicit option first', () => {
    vi.stubEnv('UNIVERSE_SWARM_REQUEST_TIMEOUT_MS', '1234')
    expect(resolveSwarmRequestTimeoutMs(500)).toBe(500)
  })
  it('honours the env override when no option is given', () => {
    vi.stubEnv('UNIVERSE_SWARM_REQUEST_TIMEOUT_MS', '1234')
    expect(resolveSwarmRequestTimeoutMs(undefined)).toBe(1234)
  })
  it('falls back to the default for junk values', () => {
    expect(resolveSwarmRequestTimeoutMs(0)).toBe(30_000)
    expect(resolveSwarmRequestTimeoutMs(-5)).toBe(30_000)
    vi.stubEnv('UNIVERSE_SWARM_REQUEST_TIMEOUT_MS', 'nope')
    expect(resolveSwarmRequestTimeoutMs(undefined)).toBe(30_000)
  })
})

describe('SwarmApi request timeout', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function api(timeoutMs = 50) {
    return new SwarmApi({
      baseUrl: 'https://swarm.example.com/',
      apiVersion: 'v11',
      getAuth: async () => 'Basic X',
      timeoutMs,
    })
  }

  /** Mock fetch that behaves like a real hung request: never resolves, rejects
   *  with the signal's reason once the client aborts (what undici does for
   *  AbortSignal.timeout). The reason is a DOMException, not an Error. */
  function hangUntilAborted() {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal
      if (signal?.aborted) return Promise.reject(signal.reason)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    })
  }

  it('rejects a stalled fetch as a Network error (no retry — the next poll tick recovers)', async () => {
    hangUntilAborted()
    const err = await api()
      .get('reviews')
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: SwarmErrorCode.Network })
    expect((err as Error).message).toContain('timed out after 50ms')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recovers on the next request once the gateway answers again', async () => {
    hangUntilAborted()
    await expect(api().get('reviews')).rejects.toMatchObject({
      code: SwarmErrorCode.Network,
    })
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const res = await api().get<{ ok: boolean }>('reviews')
    expect(res).toEqual({ ok: true })
  })

  it('does not retry a caller-initiated abort', async () => {
    hangUntilAborted()
    const controller = new AbortController()
    const pending = api(60_000).get('reviews', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: SwarmErrorCode.Network })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
