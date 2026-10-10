#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MCP debug-server fixture — a minimal, dependency-free MCP server over stdio,
 *  used by the replay-debugger tests (unit + e2e) as a real child process.
 *
 *    tools/list  → echo { text }        | fail { message? }
 *    tools/call  → echo echoes its arguments back as text + structuredContent
 *                  fail always answers with isError:true (a *normal* server reply)
 *
 *  Env switches:
 *    UE_MCP_FIXTURE_STDERR=1    write a banner + one credential-looking line to stderr
 *    UE_MCP_FIXTURE_EXIT_MS=n   exit n ms after the first tool call (crash simulation)
 *    UE_MCP_FIXTURE_SILENT=1    never answer `initialize` (timeout simulation)
 *    UE_MCP_FIXTURE_TOOL_DELAY_MS=n  delay each tools/call reply
 *
 *  Committed as plain JS so it can be spawned via `node mcpDebugServer.cjs` with
 *  no build step.
 *--------------------------------------------------------------------------------------------*/

'use strict'

const stderrBanner = process.env.UE_MCP_FIXTURE_STDERR === '1'
const exitAfterCallMs = Number(process.env.UE_MCP_FIXTURE_EXIT_MS || 0)
const silent = process.env.UE_MCP_FIXTURE_SILENT === '1'
const toolDelayMs = Number(process.env.UE_MCP_FIXTURE_TOOL_DELAY_MS || 0)

const SERVER_INFO = { name: 'mcp-debug-fixture', version: '1.2.3' }

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes the arguments it receives.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back' } },
      required: ['text'],
    },
    outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
  },
  {
    name: 'fail',
    title: 'Fail',
    description: 'Always answers with isError:true.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
  },
]

let buffer = ''

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function handleCall(id, params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}
  if (name === 'echo') {
    const text = typeof args.text === 'string' ? args.text : ''
    void (async () => {
      if (toolDelayMs > 0) await delay(toolDelayMs)
      reply(id, {
        content: [{ type: 'text', text: 'echo: ' + text }],
        structuredContent: { echoed: text },
      })
      scheduleExit()
    })()
    return
  }
  if (name === 'fail') {
    const message = typeof args.message === 'string' ? args.message : 'fixture failure'
    void (async () => {
      if (toolDelayMs > 0) await delay(toolDelayMs)
      reply(id, {
        isError: true,
        content: [{ type: 'text', text: 'ERROR: ' + message }],
      })
      scheduleExit()
    })()
    return
  }
  fail(id, -32602, 'Unknown tool: ' + String(name))
}

function scheduleExit() {
  if (exitAfterCallMs > 0) setTimeout(() => process.exit(7), exitAfterCallMs)
}

function handle(msg) {
  if (msg.id === undefined || msg.id === null) return // notification — nothing to do
  switch (msg.method) {
    case 'initialize':
      if (silent) return // exercise the client's timeout path
      return reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Fixture server for the replay debugger.',
      })
    case 'ping':
      return reply(msg.id, {})
    case 'tools/list':
      return reply(msg.id, { tools: TOOLS })
    case 'tools/call':
      return handleCall(msg.id, msg.params)
    default:
      return fail(msg.id, -32601, 'Method not found: ' + msg.method)
  }
}

if (stderrBanner) {
  process.stderr.write('mcp-debug-fixture starting\n')
  process.stderr.write('config: {"token":"super-secret-value","mode":"debug"}\n')
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
      process.stderr.write('mcp-debug-fixture: bad json: ' + err.message + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
