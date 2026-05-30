#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AskUserQuestion agent fixture — a minimal ACP-compatible JSON-RPC server
 *  over stdio that, on every prompt, issues a single `AskUserQuestion` over the
 *  ACP `extMethod` channel, waits for the client's answer, then echoes the
 *  answer back as an agent message and ends the turn.
 *
 *  Used by smoke.askUserQuestion.spec to exercise the full extMethod round-trip
 *  (agent → client → QuestionCard / probe → agent) over a real stdio pipe.
 *
 *  Committed as plain JS so it can be spawned via `node askAgent.cjs` with no
 *  build step.
 *--------------------------------------------------------------------------------------------*/

'use strict'

const ASK_METHOD = 'universe-editor/ask_user_question'

let buffer = ''
let nextSessionId = 1
let nextReqId = 1
const pending = new Map() // agent-issued request id -> { resolve }

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

/** Send an agent→client request and resolve when the response arrives. */
function request(method, params) {
  const id = `agent-req-${nextReqId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId
  const answer = await request(ASK_METHOD, {
    sessionId,
    toolCallId: 'ask-1',
    questions: [
      {
        question: 'Pick a color?',
        header: 'Color',
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
        multiSelect: false,
      },
    ],
  })
  const picked =
    answer && !answer.cancelled && answer.answers
      ? Object.values(answer.answers).join('; ')
      : '<cancelled>'
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'you picked: ' + picked },
    },
  })
  reply(id, { stopReason: 'end_turn' })
}

function handle(msg) {
  // Response to an agent-initiated request (no method, has id).
  if (msg.method === undefined && msg.id != null) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'request failed'))
      else p.resolve(msg.result)
    }
    return
  }
  // Notification (no id).
  if (msg.id === undefined || msg.id === null) {
    return
  }
  // Request from the client.
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} })
    case 'session/new':
      return reply(msg.id, { sessionId: 'ask-' + nextSessionId++ })
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
      handle(JSON.parse(line))
    } catch (err) {
      process.stderr.write('askAgent: bad json: ' + err.message + ' :: ' + line + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
