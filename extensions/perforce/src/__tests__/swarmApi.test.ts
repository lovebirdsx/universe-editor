import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SwarmApi,
  SwarmError,
  SwarmErrorCode,
  mapHttpError,
  buildQuery,
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
