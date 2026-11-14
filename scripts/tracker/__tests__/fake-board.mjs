/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  测试用的本地 tracker HTTP 假服务器：覆盖 board 适配器与 MCP 协议需要的公开/鉴权路由。
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:http'

export const TEST_USERNAME = 'testuser'
export const TEST_PASSWORD = 'test-password'

const BOARD = {
  _id: 'board-1',
  name: 'universe-editor',
  tags: [
    { _id: 'tag-ai', name: 'ai-ready' },
    { _id: 'tag-bug', name: 'bug' },
  ],
}

const USERS = [
  { _id: 'u1', username: 'alice' },
  { _id: 'u2', username: 'bob' },
]

function initialPosts() {
  return [
    {
      _id: 'p1',
      board: 'board-1',
      title: 'Add widget',
      content: '## Body\n\nWidget spec',
      status: 'Planned',
      tags: ['tag-ai'],
      priority: 2,
      effort: 3,
      createdBy: 'u1',
      owner: 'u2',
      createdAt: '2026-01-02T00:00:00.000Z',
      attachments: [{ name: 'spec.md', path: '/files/spec.md' }],
    },
    {
      _id: 'p2',
      board: 'board-1',
      title: 'Fix bug',
      content: '',
      status: 'Open',
      tags: ['tag-bug'],
      createdAt: '2026-01-03T00:00:00.000Z',
    },
    {
      _id: 'p3',
      board: 'board-1',
      title: 'Ship done',
      content: '',
      status: 'Complete',
      tags: ['tag-ai'],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      _id: 'p4',
      board: 'board-1',
      title: 'Under review',
      content: '',
      status: 'UnderReview',
      tags: ['tag-ai'],
      createdAt: '2026-01-04T00:00:00.000Z',
    },
    {
      _id: 'p5',
      board: 'board-1',
      title: 'Planned bug',
      content: '',
      status: 'Planned',
      tags: ['tag-bug'],
      createdAt: '2026-01-05T00:00:00.000Z',
    },
  ]
}

function initialComments() {
  return {
    p1: [
      {
        _id: 'c1',
        post: 'p1',
        content: 'first comment',
        createdBy: 'u1',
        createdAt: '2026-01-02T01:00:00.000Z',
      },
      {
        _id: 'c2',
        post: 'p1',
        content: 'claimed\n\n<!-- tracker-claim:run-old -->',
        createdBy: 'u2',
        createdAt: '2026-01-02T02:00:00.000Z',
      },
    ],
  }
}

export function createBoardState() {
  return {
    posts: initialPosts(),
    comments: initialComments(),
    logins: 0,
    commentSeq: 0,
    invalidTokens: new Set(),
    rejectNextAuth: false,
    lastAuthCookie: undefined,
    lastByBoardBody: undefined,
    commentRequests: [],
  }
}

export function resetBoardState(state) {
  Object.assign(state, createBoardState())
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text === '' ? undefined : JSON.parse(text))
      } catch {
        resolve(undefined)
      }
    })
  })
}

function readToken(req) {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)jwt=([^;]+)/.exec(cookie)
  return match?.[1]
}

function validToken(state, token) {
  return typeof token === 'string' && token !== '' && !state.invalidTokens.has(token)
}

async function handle(req, res, state) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (req.method === 'POST' && path === '/auth/local') {
    const body = await readJson(req)
    if (body?.username !== TEST_USERNAME || body?.password !== TEST_PASSWORD) {
      sendJson(res, 401, { message: 'Unauthorized' })
      return
    }
    state.logins++
    sendJson(res, 200, { accessToken: `tok-${state.logins}` })
    return
  }

  if (req.method === 'GET' && path === '/board/not-deleted') {
    sendJson(res, 200, [BOARD])
    return
  }

  if (req.method === 'POST' && path === '/posts/by-board') {
    const body = await readJson(req)
    state.lastByBoardBody = body
    let posts = state.posts.filter((post) => post.board === body?.board)
    if (body?.status !== undefined) posts = posts.filter((post) => post.status === body.status)
    if (Array.isArray(body?.tags) && body.tags.length > 0) {
      posts = posts.filter((post) => (post.tags ?? []).every((tag) => body.tags.includes(tag)))
    }
    posts = posts
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    if (body?.limit !== undefined) posts = posts.slice(0, body.limit)
    sendJson(res, 200, posts)
    return
  }

  const commentsMatch = /^\/posts\/([^/]+)\/comments$/.exec(path)
  if (req.method === 'GET' && commentsMatch) {
    sendJson(res, 200, state.comments[commentsMatch[1]] ?? [])
    return
  }

  const postMatch = /^\/posts\/([^/]+)$/.exec(path)
  if (req.method === 'GET' && postMatch) {
    const post = state.posts.find((item) => item._id === postMatch[1])
    if (!post) {
      sendJson(res, 404, { message: 'Not Found' })
      return
    }
    sendJson(res, 200, post)
    return
  }

  if (req.method === 'GET' && path === '/users') {
    sendJson(res, 200, USERS)
    return
  }

  if (req.method === 'POST' && path === '/posts/add-comment') {
    const token = readToken(req)
    if (state.rejectNextAuth && validToken(state, token)) {
      state.invalidTokens.add(token)
      state.rejectNextAuth = false
      sendJson(res, 401, { message: 'Unauthorized' })
      return
    }
    if (!validToken(state, token)) {
      sendJson(res, 401, { message: 'Unauthorized' })
      return
    }
    const body = await readJson(req)
    state.lastAuthCookie = req.headers.cookie
    const post = state.posts.find((item) => item._id === body?.post)
    if (!post) {
      sendJson(res, 404, { message: 'Not Found' })
      return
    }
    if (body?.op?.type === 'changePostStatus') post.status = body.op.postStatus
    const comment = {
      _id: `c-new-${++state.commentSeq}`,
      post: body.post,
      content: body.content ?? '',
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
    }
    if (!state.comments[body.post]) state.comments[body.post] = []
    state.comments[body.post].push(comment)
    state.commentRequests.push({
      post: body.post,
      content: body.content,
      op: body.op,
    })
    sendJson(res, 200, comment)
    return
  }

  sendJson(res, 404, { message: `No route for ${req.method} ${path}` })
}

export async function startFakeBoard() {
  const state = createBoardState()
  const server = createServer((req, res) => {
    handle(req, res, state).catch((error) => {
      sendJson(res, 500, { message: String(error?.message ?? error) })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
