/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  测试用的本地 Streamable HTTP MCP 假服务器：按 tracker 契约 v1 响应 tools/call，
 *  可切换 application/json 与 text/event-stream 两种响应形态。
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:http'
import { createMcpState, resetMcpState } from './fake-mcp-state.mjs'

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

function success(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

function failure(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
    structuredContent: { code, message },
  }
}

function summary(requirement) {
  const result = {
    id: requirement.id,
    title: requirement.title,
    status: requirement.status,
    labels: requirement.labels,
    project: requirement.project,
    createdAt: requirement.createdAt,
  }
  if (typeof requirement.priority === 'number') result.priority = requirement.priority
  if (typeof requirement.effort === 'number') result.effort = requirement.effort
  if (requirement.url !== undefined) result.url = requirement.url
  return result
}

function handleTool(state, name, args = {}) {
  state.toolCalls.push({ name, args })

  if (name === 'get_tracker_capabilities') {
    return success({
      contractVersion: 1,
      tracker: 'fake-mcp',
      statuses: ['open', 'planned', 'in_progress', 'done', 'closed'],
      claim: 'best-effort',
      projects: [{ id: 'board-1', name: 'universe-editor' }],
    })
  }

  if (name === 'list_requirements') {
    const limit = args.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return failure('INVALID', 'limit 必须在 1..100 之间')
    }
    const skip = decodeSkip(args.cursor)
    if (skip === undefined) return failure('INVALID', 'cursor 无效')

    let items = state.requirements.slice()
    if (args.project !== undefined) {
      items = items.filter((item) => item.project === args.project || item.boardId === args.project)
    }
    if (Array.isArray(args.status) && args.status.length > 0) {
      items = items.filter((item) => args.status.includes(item.status))
    }
    if (Array.isArray(args.labels) && args.labels.length > 0) {
      items = items.filter((item) => args.labels.every((label) => item.labels.includes(label)))
    }
    if (args.since !== undefined) {
      const since = Date.parse(args.since)
      items = items.filter((item) => Date.parse(item.createdAt) >= since)
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

    const result = { items: items.slice(skip, skip + limit).map(summary) }
    if (skip + limit < items.length) {
      result.nextCursor = Buffer.from(String(skip + limit), 'utf8').toString('base64url')
    }
    return success(result)
  }

  if (name === 'get_requirement') {
    const requirement = state.requirements.find((item) => item.id === args.id)
    if (!requirement) return failure('NOT_FOUND', `需求 ${args.id} 不存在`)
    return success({
      ...summary(requirement),
      body: requirement.body,
      author: requirement.author,
      assignees: requirement.assignees,
      attachments: requirement.attachments,
      comments: requirement.comments,
    })
  }

  if (name === 'claim_requirement') {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(args.runId))) {
      return failure('INVALID', 'runId 非法')
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(args.idempotencyKey))) {
      return failure('INVALID', 'idempotencyKey 非法')
    }
    const requirement = state.requirements.find((item) => item.id === args.id)
    if (!requirement) return failure('NOT_FOUND', `需求 ${args.id} 不存在`)
    requirement.claimedRunIds ??= []
    if (requirement.claimedRunIds.includes(args.runId)) {
      return success({ claimed: true, claimedBy: args.runId, status: requirement.status })
    }
    if (requirement.claimedRunIds.length > 0 && requirement.status === 'in_progress') {
      return success({
        claimed: false,
        claimedBy: requirement.claimedRunIds[0],
        status: requirement.status,
      })
    }
    if (requirement.status === 'done' || requirement.status === 'closed') {
      return failure('CONFLICT', `需求 ${args.id} 已处于 ${requirement.status} 状态，无法认领`)
    }
    requirement.claimedRunIds.push(args.runId)
    requirement.status = 'in_progress'
    return success({ claimed: true, claimedBy: args.runId, status: 'in_progress' })
  }

  if (name === 'comment_requirement') {
    if (typeof args.body !== 'string' || args.body.length > 20000) {
      return failure('INVALID', 'body 非法')
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(args.idempotencyKey))) {
      return failure('INVALID', 'idempotencyKey 非法')
    }
    if (!state.requirements.some((item) => item.id === args.id)) {
      return failure('NOT_FOUND', `需求 ${args.id} 不存在`)
    }
    const existing = state.comments.get(args.idempotencyKey)
    if (existing !== undefined) return success({ commentId: existing, duplicate: true })
    const commentId = `comment-${state.commentSeq++}`
    state.comments.set(args.idempotencyKey, commentId)
    return success({ commentId, duplicate: false })
  }

  if (name === 'transition_requirement') {
    const requirement = state.requirements.find((item) => item.id === args.id)
    if (!requirement) return failure('NOT_FOUND', `需求 ${args.id} 不存在`)
    if (!['open', 'planned', 'in_progress', 'done', 'closed'].includes(args.to)) {
      return failure('INVALID', `不支持的需求状态: ${args.to}`)
    }
    const from = requirement.status
    if (from === args.to) return success({ from, to: args.to, changed: false })
    if (state.transitions.has(args.idempotencyKey)) {
      return success({ from, to: args.to, changed: false })
    }
    state.transitions.set(args.idempotencyKey, { from, to: args.to })
    requirement.status = args.to
    return success({ from, to: args.to, changed: true })
  }

  return failure('INVALID', `未知工具 ${name}`)
}

function decodeSkip(cursor) {
  if (cursor === undefined) return 0
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  return /^\d+$/.test(text) ? Number(text) : undefined
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function handleMessage(state, message) {
  if (message.method === 'initialize') {
    return jsonRpcResult(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-tracker', version: '1.0.0' },
    })
  }
  if (message.method === 'notifications/initialized') return undefined
  if (message.method === 'tools/list') {
    return jsonRpcResult(message.id, {
      tools: [
        'get_tracker_capabilities',
        'list_requirements',
        'get_requirement',
        'claim_requirement',
        'comment_requirement',
        'transition_requirement',
      ].map((name) => ({ name, inputSchema: { type: 'object' } })),
    })
  }
  if (message.method === 'tools/call') {
    return jsonRpcResult(
      message.id,
      handleTool(state, message.params?.name, message.params?.arguments),
    )
  }
  return {
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  }
}

function send(state, res, status, body, contentType = 'application/json') {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': contentType })
  res.end(text)
}

function sendRpc(state, res, response) {
  if (state.responseMode === 'sse' && response !== undefined) {
    send(
      state,
      res,
      200,
      `event: message\ndata: ${JSON.stringify(response)}\n\n`,
      'text/event-stream',
    )
    return
  }
  send(state, res, 200, response, 'application/json')
}

async function handle(req, res, state) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method !== 'POST' || url.pathname !== '/mcp') {
    send(state, res, 405, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'POST /mcp' },
    })
    return
  }

  const message = await readJson(req)
  state.requests.push({ headers: req.headers, message })

  if (state.responseMode === 'unauthorized') {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="fake"' })
    res.end()
    return
  }
  const expected = `Bearer ${state.token}`
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="fake"' })
    res.end()
    return
  }
  if (state.failNextStatus !== undefined) {
    const status = state.failNextStatus
    state.failNextStatus = undefined
    send(state, res, status, { error: 'forced' })
    return
  }

  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    sendRpc(state, res, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    })
    return
  }

  const response = handleMessage(state, message)
  if (response === undefined) {
    send(state, res, 202)
    return
  }
  sendRpc(state, res, response)
}

export async function startFakeMcp({ token = 'read-token' } = {}) {
  const state = createMcpState()
  state.token = token
  const server = createServer((req, res) => {
    handle(req, res, state).catch((error) => {
      send(state, res, 500, { message: String(error?.message ?? error) })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    state,
    reset: () => resetMcpState(state, token),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
