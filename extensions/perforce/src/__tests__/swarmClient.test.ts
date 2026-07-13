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

    const dash = await client().dashboard()

    expect(dash.authored.map((r) => r.id)).toEqual(['1001'])
    expect(dash.needsAction.map((r) => r.id)).toEqual(['1001'])
    // The redundant, often-broken v9 endpoint is never hit.
    const actionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/dashboards/action'),
    )
    expect(actionCalls).toHaveLength(0)
  })

  it('excludes closed reviews from the derived needsAction set', async () => {
    fetchMock.mockImplementation((url: string) => {
      const body = url.includes('author[]')
        ? { reviews: [reviewJson('1001', 'approved'), reviewJson('1002', 'needsRevision')] }
        : { reviews: [] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    })

    const dash = await client().dashboard()

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
    const a = c.dashboard()
    const b = c.dashboard() // second caller while the first is still in flight
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
    await client().setTaskState('42', 'addressed')
    const [url, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('PATCH')
    expect(url).toBe('https://swarm.example.com/api/v9/comments/42')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ taskState: 'addressed' })
  })
})
