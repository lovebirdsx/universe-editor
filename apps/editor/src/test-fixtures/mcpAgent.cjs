#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MCP observability agent fixture — a minimal ACP-compatible JSON-RPC server
 *  over stdio that exercises the MCP UI end to end:
 *    - on prompt, emits the Claude SDK system-init snapshot via the
 *      `_claude/sdkMessage` extNotification (the same shape the real agent fork
 *      sends, see vendor/claude-agent-acp/src/acp-agent.ts:815), carrying a
 *      `mcp_servers: { name, status }[]` list;
 *    - then runs one tool_call attributed to an MCP server via
 *      `_meta.claudeCode.toolName = 'mcp__<server>__<tool>'`;
 *    - ends the turn.
 *
 *  Used by smoke.mcpServers.spec to verify the full cross-process MCP data path
 *  (agent → extNotification → AcpSessionService → session.mcpServers / StatusBar
 *  tooltip / MCP view) over a real stdio pipe.
 *
 *  Committed as plain JS so it can be spawned via `node mcpAgent.cjs` with no
 *  build step.
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
  const turn = { cancelled: false }
  activeTurns.set(sessionId, turn)

  // 1. Push the Claude SDK system-init MCP snapshot (real connection status).
  notify('_claude/sdkMessage', {
    sessionId,
    message: {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'fs', status: 'connected' },
        { name: 'docs', status: 'failed' },
      ],
    },
  })
  await delay(5)
  if (turn.cancelled) {
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'cancelled' })
  }

  // 2. Run an MCP-attributed tool_call (mcp__<server>__<tool> on _meta).
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'fs-read',
      title: 'read_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/tmp/example.txt', limit: 100 },
      _meta: { claudeCode: { toolName: 'mcp__fs__read_file' } },
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
      toolCallId: 'fs-read',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: '{"ok":true,"lines":2,"path":"/tmp/example.txt"}' },
        },
      ],
    },
  })

  activeTurns.delete(sessionId)
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
      return reply(msg.id, { sessionId: 'mcp-' + nextSessionId++ })
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
      process.stderr.write('mcpAgent: bad json: ' + err.message + ' :: ' + line + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
