#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Fake Helix Swarm REST server for e2e / manual testing of the perforce
 *  extension's `swarm/` submodule.
 *
 *  This machine (and CI) has no reachable Swarm server, so the review layer can't
 *  be exercised end-to-end against a real one. This script stands in: a pure-Node
 *  `http` server that speaks just enough of the Swarm API (the endpoints the
 *  extension consumes) over a small in-memory review model, and records every
 *  request so specs can assert the extension issued the right calls.
 *
 *  The extension points at it via `UNIVERSE_SWARM_BASE_URL` (swarmApi honours the
 *  override). It listens on an ephemeral port and writes `{"baseUrl":...}` to the
 *  file named by `UNIVERSE_SWARM_FAKE_PORTFILE` so the harness can read the URL.
 *  Requests are appended (one JSON line each) to `UNIVERSE_SWARM_FAKE_LOG`.
 *
 *  Auth is accepted unconditionally (any Authorization header) — credential
 *  plumbing is covered by unit tests; this focuses on the request/response flow.
 *
 *  Deliberately dependency-free and pure Node so it runs with no build step.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const PORTFILE = process.env.UNIVERSE_SWARM_FAKE_PORTFILE
const LOG = process.env.UNIVERSE_SWARM_FAKE_LOG

/** In-memory review model. Seeded with two reviews the e2e user participates in
 *  (distinct author / description / version so switching between them exercises a
 *  full detail refresh, not just the comments panel). */
const reviews = {
  1001: {
    id: '1001',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'alice',
    description: 'Add greeting\n\nImplements the hello path.',
    updated: 1_700_000_000,
    versions: [{ rev: 1, change: '900', pending: true, time: 1_700_000_000 }],
    participants: { e2e: { vote: { value: 0 }, required: true } },
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'pass',
  },
  1002: {
    id: '1002',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'bob',
    description: 'Fix farewell\n\nCorrects the goodbye path.',
    updated: 1_700_000_100,
    versions: [{ rev: 1, change: '901', pending: true, time: 1_700_000_100 }],
    participants: { e2e: { vote: { value: 0 }, required: true } },
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'pass',
  },
  1003: {
    id: '1003',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'carol',
    description: 'Tune buff table\n\nEdits a binary spreadsheet.',
    updated: 1_700_000_200,
    versions: [{ rev: 1, change: '903', pending: true, time: 1_700_000_200 }],
    participants: { e2e: { vote: { value: 0 }, required: true } },
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'pass',
  },
  1004: {
    id: '1004',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'dave',
    description: 'Patch shared lib\n\nEdits a file outside the workspace client view.',
    updated: 1_700_000_300,
    versions: [{ rev: 1, change: '904', pending: true, time: 1_700_000_300 }],
    participants: { e2e: { vote: { value: 0 }, required: true } },
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'pass',
  },
  1005: {
    id: '1005',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'erin',
    description: 'Bump d constant\n\nBacked by a submitted changelist.',
    updated: 1_700_000_400,
    // Backing change 906 is SUBMITTED: describe -S reports the file at #6 (the
    // revision containing the edit), so the diff base must resolve to #5.
    versions: [{ rev: 1, change: '906', pending: false, time: 1_700_000_400 }],
    participants: { e2e: { vote: { value: 0 }, required: true } },
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'pass',
  },
}
const comments = {}
let nextReviewId = 1005
let nextCommentId = 1

function logRequest(entry) {
  if (!LOG) return
  try {
    appendFileSync(LOG, JSON.stringify(entry) + '\n')
  } catch {
    /* ignore */
  }
}

function reviewListItem(r) {
  return {
    id: r.id,
    state: r.state,
    stateLabel: r.stateLabel,
    author: r.author,
    description: r.description.split('\n')[0],
    upVotes: 0,
    downVotes: 0,
    commentCount: r.commentCount,
    openTaskCount: r.openTaskCount,
    testStatus: r.testStatus,
    updated: r.updated,
  }
}

function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/^\/api\/v\d+\//, '')
  const method = req.method ?? 'GET'
  const body = method === 'GET' ? undefined : await readBody(req)
  logRequest({ method, path, query: url.search, body })

  // Test-only control endpoint (not part of the Swarm API): inject a brand-new
  // review at runtime so specs can exercise the "new review needs my action"
  // notification path. Deliberately outside the /api/vN prefix so it can never
  // collide with a real endpoint. Not recorded above as a Swarm request.
  if (method === 'POST' && url.pathname === '/__control__/add-review') {
    const id = body.id ?? String(nextReviewId++)
    reviews[id] = {
      id,
      state: 'needsReview',
      stateLabel: 'Needs Review',
      author: body.author ?? 'dave',
      description: body.description ?? `Injected review ${id}`,
      updated: 1_700_000_900,
      versions: [{ rev: 1, change: body.change ?? '0', pending: true, time: 1_700_000_900 }],
      // Make the e2e user a required participant so it lands in needs-my-action.
      participants: { e2e: { vote: { value: 0 }, required: true } },
      commentCount: 0,
      openTaskCount: 0,
      testStatus: 'none',
    }
    send(res, 200, { review: reviews[id] })
    return
  }

  // GET reviews (list / ping). Honours the `keywords` query so the extension can
  // push keyword filtering down to the server (matched against description /
  // author / id, mirroring the renderer's client-side fallback). Also honours the
  // `author[]` / `participants[]` / `state[]` filters the dashboard derivation
  // relies on — without them `author=e2e` would return every seeded review,
  // collapsing the authored / needs-my-action buckets into one.
  if (method === 'GET' && path === 'reviews') {
    const keywords = (url.searchParams.get('keywords') ?? '').trim().toLowerCase()
    const authors = url.searchParams.getAll('author[]')
    const participants = url.searchParams.getAll('participants[]')
    const states = url.searchParams.getAll('state[]')
    let list = Object.values(reviews)
    if (authors.length) {
      list = list.filter((r) => authors.includes(r.author))
    }
    if (participants.length) {
      list = list.filter((r) => participants.some((p) => p in r.participants))
    }
    if (states.length) {
      list = list.filter((r) => states.includes(r.state))
    }
    if (keywords) {
      list = list.filter(
        (r) =>
          r.description.toLowerCase().includes(keywords) ||
          r.author.toLowerCase().includes(keywords) ||
          r.id.includes(keywords),
      )
    }
    send(res, 200, {
      reviews: list.map(reviewListItem),
      lastSeen: null,
    })
    return
  }

  // GET dashboards/action
  if (method === 'GET' && path === 'dashboards/action') {
    const needs = Object.values(reviews).filter((r) => r.state === 'needsReview')
    send(res, 200, { reviews: needs.map(reviewListItem), lastSeen: null })
    return
  }

  // GET reviews/{id}/transitions
  let m = /^reviews\/([^/]+)\/transitions$/.exec(path)
  if (method === 'GET' && m) {
    send(res, 200, {
      transitions: {
        needsRevision: 'Needs Revision',
        approved: 'Approve',
        'approved:commit': 'Approve and Commit',
        rejected: 'Reject',
      },
    })
    return
  }

  // GET reviews/{id}
  m = /^reviews\/([^/]+)$/.exec(path)
  if (method === 'GET' && m) {
    const r = reviews[m[1]]
    if (!r) return send(res, 404, { error: 'not found' })
    send(res, 200, { review: r })
    return
  }

  // POST reviews (create)
  if (method === 'POST' && path === 'reviews') {
    const id = String(nextReviewId++)
    reviews[id] = {
      id,
      state: 'needsReview',
      stateLabel: 'Needs Review',
      author: 'e2e',
      description: body.description ?? '',
      updated: 1_700_000_500,
      versions: [{ rev: 1, change: body.change ?? '0', pending: true, time: 1_700_000_500 }],
      participants: {},
      commentCount: 0,
      openTaskCount: 0,
      testStatus: 'none',
    }
    send(res, 200, { review: reviews[id] })
    return
  }

  // POST reviews/{id}/vote
  m = /^reviews\/([^/]+)\/vote$/.exec(path)
  if (method === 'POST' && m) {
    send(res, 200, {})
    return
  }

  // POST reviews/{id}/changes
  m = /^reviews\/([^/]+)\/changes$/.exec(path)
  if (method === 'POST' && m) {
    send(res, 200, {})
    return
  }

  // POST reviews/{id}/obliterate
  m = /^reviews\/([^/]+)\/obliterate$/.exec(path)
  if (method === 'POST' && m) {
    const id = m[1]
    if (!reviews[id]) return send(res, 404, { error: 'not found' })
    delete reviews[id]
    send(res, 200, {
      isValid: true,
      message: `The review with id [${id}] has been obliterated.`,
      code: 200,
    })
    return
  }

  // PATCH reviews/{id}/state
  m = /^reviews\/([^/]+)\/state$/.exec(path)
  if (method === 'PATCH' && m) {
    const r = reviews[m[1]]
    if (r && body.state) {
      r.state = String(body.state).split(':')[0]
    }
    send(res, 200, { review: r })
    return
  }

  // GET comments?topic=reviews/{id} (topic-based resource, not nested)
  if (method === 'GET' && path === 'comments') {
    const topic = url.searchParams.get('topic') ?? ''
    const id = /^reviews\/(.+)$/.exec(topic)?.[1] ?? ''
    send(res, 200, { comments: comments[id] ?? [] })
    return
  }

  // POST comments (topic in body: reviews/{id})
  if (method === 'POST' && path === 'comments') {
    const id = /^reviews\/(.+)$/.exec(body.topic ?? '')?.[1] ?? ''
    const comment = {
      id: String(nextCommentId++),
      body: body.body ?? '',
      user: 'e2e',
      taskState: body.taskState ?? 'comment',
      updated: 1_700_000_600,
      ...(body.context ? { context: body.context } : {}),
    }
    comments[id] = comments[id] ?? []
    comments[id].push(comment)
    send(res, 200, { comment })
    return
  }

  // PATCH comments/{id} (edit a comment / set its task state)
  m = /^comments\/([^/]+)$/.exec(path)
  if (method === 'PATCH' && m) {
    send(res, 200, {})
    return
  }

  send(res, 404, { error: `unhandled ${method} ${path}` })
})

server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`
  if (PORTFILE) writeFileSync(PORTFILE, JSON.stringify({ baseUrl }), 'utf8')
  process.stdout.write(`fake-swarm listening on ${baseUrl}\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
