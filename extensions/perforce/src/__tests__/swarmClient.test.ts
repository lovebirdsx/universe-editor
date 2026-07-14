import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SwarmClient } from '../swarm/swarmClient.js'
import type { P4Service } from '../p4Service.js'

/**
 * A p4 stub that reports a live session and one cached ticket, so
 * resolveSwarmCredential yields a Basic header without any real p4 round-trip.
 */
function fakeP4(user: string): P4Service {
  return {
    exec: vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'login' && args[1] === '-s') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'tickets') {
        return { exitCode: 0, stdout: `server:1666 (${user}) ABC123TICKET\n`, stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }),
  } as unknown as P4Service
}

function reviewJson(id: string, state: string) {
  return { id, state, author: 'songxiao', description: `review ${id}` }
}

describe('SwarmClient.dashboard', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client() {
    return new SwarmClient(fakeP4('songxiao'), {
      baseUrl: 'https://swarm.example.com/',
      apiVersion: 'v9',
      user: 'songxiao',
    })
  }

  it('never calls dashboards/action — derives needsAction locally', async () => {
    fetchMock.mockImplementation((url: string) => {
      // author[] → an open review, so the local derivation surfaces it as needsAction.
      const body = url.includes('author[]')
        ? { reviews: [reviewJson('1001', 'needsReview')] }
        : { reviews: [] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })

    const dash = await client().dashboard({})

    expect(dash.authored.map((r) => r.id)).toEqual(['1001'])
    expect(dash.needsAction.map((r) => r.id)).toEqual(['1001'])
    // The redundant, often-broken v9 endpoint is never hit.
    const actionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/dashboards/action'),
    )
    expect(actionCalls).toHaveLength(0)
  })

  it('pushes a keyword filter down to both list queries', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reviews: [] }), { status: 200 }))

    await client().dashboard({ keywords: 'greeting' })

    // Both the authored and participating queries carry the keyword — the server
    // narrows the result instead of the renderer fetching everything and filtering.
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toHaveLength(2)
    for (const url of urls) expect(url).toContain('keywords=greeting')
    expect(urls.some((u) => u.includes('author[]=songxiao'))).toBe(true)
    expect(urls.some((u) => u.includes('participants[]=songxiao'))).toBe(true)
  })

  it('trims a whitespace-only keyword back to an unfiltered query', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reviews: [] }), { status: 200 }))

    await client().dashboard({ keywords: '   ' })

    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain('keywords=')
  })

  it('excludes closed reviews from the derived needsAction set', async () => {
    fetchMock.mockImplementation((url: string) => {
      const body = url.includes('author[]')
        ? { reviews: [reviewJson('1001', 'approved'), reviewJson('1002', 'needsRevision')] }
        : { reviews: [] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })

    const dash = await client().dashboard({})

    // Only the still-open review is actionable; the approved one is done.
    expect(dash.needsAction.map((r) => r.id)).toEqual(['1002'])
  })

  it('coalesces concurrent callers onto a single fetch fan-out', async () => {
    let resolveList: (() => void) | undefined
    const gate = new Promise<void>((r) => (resolveList = r))
    fetchMock.mockImplementation(async () => {
      await gate // hold the list queries open so both callers overlap
      return new Response(JSON.stringify({ reviews: [] }), { status: 200 })
    })

    const c = client()
    const a = c.dashboard({})
    const b = c.dashboard({}) // second caller while the first is still in flight
    resolveList?.()
    await Promise.all([a, b])

    // One fan-out total (author + participants), not two.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * Comments are a topic-based resource in Swarm's v9 API — the earlier
 * `comments/reviews/{id}` nesting 404s. Pin the correct wire paths so a
 * regression is caught in unit tests, not against a live server.
 */
describe('SwarmClient comment endpoints', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client() {
    return new SwarmClient(fakeP4('songxiao'), {
      baseUrl: 'https://swarm.example.com/',
      apiVersion: 'v9',
      user: 'songxiao',
    })
  }

  it('lists comments via GET /comments?topic=reviews/{id}', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
    await client().listComments('8089913')
    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('GET')
    expect(url).toBe('https://swarm.example.com/api/v9/comments?topic=reviews%2F8089913')
  })

  it('adds a comment via POST /comments with topic in the body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ comment: { id: '1', body: 'hi' } }), { status: 200 }),
    )
    await client().addComment('8089913', 'hi')
    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect(url).toBe('https://swarm.example.com/api/v9/comments')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      topic: 'reviews/8089913',
      body: 'hi',
    })
  })

  it('sets a task state via PATCH /comments/{id}', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    await client().setTaskState('8089913', '42', 'addressed')
    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('PATCH')
    expect(url).toBe('https://swarm.example.com/api/v9/comments/42')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ taskState: 'addressed' })
  })
})

describe('SwarmClient review mutation endpoints', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client() {
    return new SwarmClient(fakeP4('songxiao'), {
      baseUrl: 'https://swarm.example.com/',
      apiVersion: 'v9',
      user: 'songxiao',
    })
  }

  it('loads server-authoritative transitions via GET /reviews/{id}/transitions', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transitions: { approved: 'Approve' } }), { status: 200 }),
    )

    await expect(client().getTransitions('8089913')).resolves.toEqual([
      { state: 'approved', label: 'Approve' },
    ])

    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('GET')
    expect(url).toBe('https://swarm.example.com/api/v9/reviews/8089913/transitions')
  })

  it('obliterates a review via POST /reviews/{id}/obliterate without a body', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          isValid: true,
          message: 'The review with id [8089913] has been obliterated.',
          code: 200,
        }),
        { status: 200 },
      ),
    )
    await client().obliterateReview('8089913')

    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect(url).toBe('https://swarm.example.com/api/v9/reviews/8089913/obliterate')
    expect((init as RequestInit).body).toBeUndefined()
  })
})

describe('SwarmClient cache', () => {
  const fetchMock = vi.fn()
  let now = 1000

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    now = 1000
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client() {
    return new SwarmClient(
      fakeP4('songxiao'),
      {
        baseUrl: 'https://swarm.example.com/',
        apiVersion: 'v9',
        user: 'songxiao',
      },
      undefined,
      { ttlMs: 1000, now: () => now },
    )
  }

  it('caches canonical review filters until the ttl expires', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ reviews: [reviewJson('1001', 'needsReview')] }), {
        status: 200,
      }),
    )
    const c = client()

    await c.listReviews({ author: ['bob', 'alice'], state: ['needsReview', 'approved'] })
    await c.listReviews({ author: ['alice', 'bob'], state: ['approved', 'needsReview'] })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1001
    await c.listReviews({ author: ['alice', 'bob'], state: ['approved', 'needsReview'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches review detail and transitions but force refresh bypasses both', async () => {
    fetchMock.mockImplementation((url: string) => {
      const body = url.endsWith('/transitions')
        ? { transitions: { approved: 'Approve' } }
        : reviewJson('1001', 'needsReview')
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })
    const c = client()

    await c.getReview('1001')
    await c.getReview('1001')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await c.getReview('1001', true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('invalidates cached comments and review data after a comment is added', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ comment: { id: '2', body: 'new' } }), { status: 200 }),
        )
      }
      if (url.includes('/comments?')) {
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
      }
      const body = url.endsWith('/transitions')
        ? { transitions: {} }
        : reviewJson('1001', 'needsReview')
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })
    const c = client()
    await c.getReview('1001')
    await c.listComments('1001')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await c.addComment('1001', 'new')
    await c.getReview('1001')
    await c.listComments('1001')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('lets a forced dashboard poll refresh cached review lists', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reviews: [] }), { status: 200 }))
    const c = client()

    await c.dashboard({})
    await c.dashboard({})
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await c.dashboard({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('coalesces overlapping forced dashboard polls', async () => {
    let resolveLists: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (resolveLists = resolve))
    fetchMock.mockImplementation(async () => {
      await gate
      return new Response(JSON.stringify({ reviews: [] }), { status: 200 })
    })
    const c = client()

    const first = c.dashboard({ force: true })
    const second = c.dashboard({ force: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    resolveLists?.()
    await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('queues one forced dashboard refresh behind an ordinary in-flight read', async () => {
    const resolvers: Array<() => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(() =>
            resolve(new Response(JSON.stringify({ reviews: [] }), { status: 200 })),
          )
        }),
    )
    const c = client()

    const ordinary = c.dashboard({})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const forced = c.dashboard({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolvers.splice(0).forEach((resolve) => resolve())
    await ordinary
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    resolvers.splice(0).forEach((resolve) => resolve())
    await forced

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
