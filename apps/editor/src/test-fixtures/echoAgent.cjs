#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Echo agent fixture — minimal ACP-compatible JSON-RPC server over stdio,
 *  intended for integration tests and E2E smoke runs.
 *
 *  Wire protocol: newline-delimited JSON-RPC 2.0.
 *  Supported requests from the editor:
 *    - initialize                        → responds with protocolVersion 1
 *    - session/new                       → responds with a fresh sessionId
 *    - session/prompt                    → emits two session/update chunks and
 *                                          a tool_call cycle, then resolves
 *                                          with stopReason='end_turn'
 *    - session/cancel (notification)     → resolves any in-flight prompt early
 *
 *  Unsupported methods return -32601 Method not found.
 *
 *  This file is committed as plain JS so vitest / integration tests can spawn
 *  it directly via `node apps/editor/src/test-fixtures/echoAgent.cjs` without
 *  a build step.
 *--------------------------------------------------------------------------------------------*/

'use strict'

let buffer = ''
let nextSessionId = 1
const activeTurns = new Map() // sessionId -> { cancelled: boolean }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId
  const userText = (params.prompt || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
  const turn = { cancelled: false }
  activeTurns.set(sessionId, turn)

  // Emit two streaming chunks.
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'echo: ' },
    },
  })
  await delay(5)
  if (turn.cancelled) {
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'cancelled' })
  }
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: userText },
    },
  })

  // Emit a tool_call lifecycle (open + close).
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'echo-tool',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
    },
  })
  await delay(5)
  if (turn.cancelled) {
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'cancelled' })
  }
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'echo-tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: userText } }],
    },
  })

  activeTurns.delete(sessionId)

  // Mirror the real agent: once the turn settles, push a friendly session
  // title via session_info_update so the editor's title pipeline can be
  // exercised end-to-end.
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      title: `Echo: ${userText}`,
    },
  })

  reply(id, { stopReason: 'end_turn' })
}

function handle(msg) {
  // Notification?
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'session/cancel') {
      const t = activeTurns.get(msg.params?.sessionId)
      if (t) t.cancelled = true
    }
    return
  }
  // Request.
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} })
    case 'session/new':
      return reply(msg.id, { sessionId: 'echo-' + nextSessionId++ })
    case 'session/prompt':
      return void runPrompt(msg.id, msg.params || {})
    default:
      return fail(msg.id, -32601, 'Method not found: ' + msg.method)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      handle(msg)
    } catch (err) {
      process.stderr.write('echoAgent: bad json: ' + err.message + ' :: ' + line + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
