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
 *    - session/load (ECHO_AGENT_LOAD_SESSION=1)
 *                                      → succeeds only for sessions that ran a
 *                                        prompt; empty sessions fail like they
 *                                        do on real agents (never persisted)
 *  ECHO_AGENT_CONFIG_OPTIONS=1: session/new advertises a set of select
 *  configOptions (model/mode/thought_level + 3 custom) and
 *  session/set_config_option applies a pick, answering with the updated bag —
 *  used by E2E to drive the config bar's overflow panel.
 *  ECHO_AGENT_SESSION_NEW_DELAY_MS=<ms> delays every session/new response —
 *  used by E2E to exercise the editor's optimistic "connecting" session row.
 *    - session/prompt                    → emits two session/update chunks and
 *                                          a tool_call cycle, then resolves
 *                                          with stopReason='end_turn'
 *    - session/cancel (notification)     → resolves any in-flight prompt early
 *
 *  Prompt text directives:
 *    - emit-image:<count>x<kb>           → streams image chunks
 *    - emit-exec:<lines>                 → execute tool_call with <lines> output
 *    - report-mcp-servers / report-cwd   → echoes session/new params
 *    - elicit-form                       → sends elicitation/create (form mode),
 *                                          echoes the user's response
 *    - elicit-url                        → sends elicitation/create (url mode),
 *                                          echoes the response, then emits
 *                                          elicitation/complete after accept
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
let nextExecId = 1
let nextClientRequestId = 1
const activeTurns = new Map() // sessionId -> { cancelled: boolean }
const pendingClientRequests = new Map() // id -> { resolve, reject } (agent->client requests)
const sessionMcpServers = new Map() // sessionId -> mcpServers array from session/new
const sessionCwds = new Map() // sessionId -> cwd from session/new
// sessionIds that have run at least one prompt. With ECHO_AGENT_LOAD_SESSION=1
// the fixture mirrors real agents: an empty session is never persisted, so
// session/load only succeeds for messaged sessions.
const messagedSessions = new Set()
const sessionPrompts = new Map() // sessionId -> [{ messageId, prompt }]
const loadSessionEnabled = process.env.ECHO_AGENT_LOAD_SESSION === '1'
const configOptionsEnabled = process.env.ECHO_AGENT_CONFIG_OPTIONS === '1'

// Select options advertised on session/new when ECHO_AGENT_CONFIG_OPTIONS=1.
// The current values keep the bar's natural width between SIDEBAR_MIN (170px,
// guaranteed overflow) and a wide sidebar (everything inline); alternatives
// are deliberately long so an overflow-panel pick also renders long labels.
const ECHO_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'opus-4-6',
    options: [
      { value: 'opus-4-6', name: 'opus-4-6' },
      { value: 'opus-4-6-lts', name: 'claude-opus-4-6-longterm-support' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: 'plan',
    options: [
      { value: 'plan', name: 'plan' },
      { value: 'bypass', name: 'bypassPermissions (auto-approve everything)' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thought level',
    type: 'select',
    category: 'thought_level',
    currentValue: 'high',
    options: [
      { value: 'high', name: 'high' },
      { value: 'ultra', name: 'ultra deep reasoning (slowest)' },
    ],
  },
  {
    id: 'profile',
    name: 'Profile',
    type: 'select',
    category: 'profile',
    currentValue: 'mid',
    options: [
      { value: 'mid', name: 'mid' },
      { value: 'aggressive', name: 'aggressive optimization profile' },
    ],
  },
  {
    id: 'verbosity',
    name: 'Verbosity',
    type: 'select',
    category: 'verbosity',
    currentValue: 'fast',
    options: [
      { value: 'fast', name: 'fast' },
      { value: 'verbose', name: 'extremely verbose explanations' },
    ],
  },
  {
    id: 'style',
    name: 'Style',
    type: 'select',
    category: 'style',
    currentValue: 'safe',
    options: [
      { value: 'safe', name: 'safe' },
      { value: 'max', name: 'max creative' },
      { value: 'extreme', name: 'maximally creative exploration' },
    ],
  },
]

// sessionId -> Map(configId -> picked value), so session/set_config_option can
// answer with the updated bag (ECHO_AGENT_CONFIG_OPTIONS=1 only).
const sessionConfigOptionValues = new Map()

function buildConfigOptions(sessionId) {
  const overrides = sessionConfigOptionValues.get(sessionId)
  if (!overrides) return ECHO_CONFIG_OPTIONS
  return ECHO_CONFIG_OPTIONS.map((o) => {
    const v = overrides.get(o.id)
    return v === undefined || v === o.currentValue ? o : { ...o, currentValue: v }
  })
}

// 2×2 red PNG, tiled to fill the emit-image directive's requested payload.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg=='

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

/** Agent->client request (e.g. elicitation/create): resolves with the client's result. */
function requestFromClient(method, params) {
  const id = 'agent-req-' + nextClientRequestId++
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId
  messagedSessions.add(sessionId)
  const promptHistory = sessionPrompts.get(sessionId) ?? []
  promptHistory.push({ messageId: params._meta?.messageId, prompt: params.prompt ?? [] })
  sessionPrompts.set(sessionId, promptHistory)
  const userText = (params.prompt || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
  const turn = { cancelled: false }
  activeTurns.set(sessionId, turn)

  // Test directive: "emit-image:<count>x<kb>" makes the agent stream <count>
  // image chunks of ~<kb> KB base64 each. This reproduces the resume path where
  // session/load replays stored images as full-base64 stdout lines — the case
  // that used to freeze the renderer via the protocol tracer.
  //
  // The payload tiles a real 2×2 PNG's base64 (never raw junk): a consumer that
  // copies the rendered image decodes the data-URI payload with nativeImage,
  // which yields an empty image for non-image bytes and would silently skip the
  // clipboard write. Real PNG bytes keep that path exercisable; the size still
  // scales with <kb> so the freeze repro is unchanged.
  const imageDirective = /^emit-image:(\d+)x(\d+)/.exec(userText)
  if (imageDirective) {
    const count = Number(imageDirective[1])
    const kb = Number(imageDirective[2])
    const targetLen = kb * 1024
    const data =
      targetLen <= PNG_BASE64.length
        ? PNG_BASE64.slice(0, targetLen)
        : PNG_BASE64.repeat(Math.ceil(targetLen / PNG_BASE64.length)).slice(0, targetLen)
    for (let i = 0; i < count; i++) {
      if (turn.cancelled) break
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', mimeType: 'image/png', data },
        },
      })
    }
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

  // Test directive: "emit-exec:<lines>" emits an `execute` tool_call whose output
  // is <lines> lines of text. Rendered via TerminalOutput, which mounts at full
  // height, then an async ResizeObserver clamps it to a fixed max-height — so the
  // row's measured height differs between fresh-mount and settled, and resets on
  // every virtualization remount. This is the shape that drives the scroll-jitter
  // limit cycle (plain text measures identically each mount and cannot).
  const execDirective = /^emit-exec:(\d+)/.exec(userText)
  if (execDirective) {
    const lines = Number(execDirective[1])
    const out = Array.from({ length: lines }, (_, k) => `output line ${k} ${'z'.repeat(60)}`).join(
      '\n',
    )
    // Unique id per turn: a fixed id makes every turn's tool_call collapse onto
    // the same timeline slot (the renderer keys by toolCallId), so N prompts
    // would show as one card.
    const execId = `exec-tool-${nextExecId++}`
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: execId,
        title: 'run command',
        kind: 'execute',
        status: 'in_progress',
      },
    })
    await delay(5)
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: execId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: out } }],
      },
    })
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

  // Test directive: "report-mcp-servers" echoes back the mcpServers array this
  // session was created with, so E2E can assert what the editor forwarded on
  // session/new (e.g. one-shot env injections that never touch the persisted
  // acp.mcpServers setting).
  if (userText === 'report-mcp-servers') {
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(sessionMcpServers.get(sessionId) ?? []) },
      },
    })
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

  // Test directive: "report-cwd" echoes back the cwd this session was created
  // with, so E2E can assert deep-link working-directory routing end to end.
  if (userText === 'report-cwd') {
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: sessionCwds.get(sessionId) ?? '' },
      },
    })
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

  // Test directive: "elicit-form" asks the client a fixed form elicitation and
  // echoes the user's response (accept+content / decline / cancel).
  if (userText === 'elicit-form') {
    const echoText = (text) =>
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      })
    try {
      const result = await requestFromClient('elicitation/create', {
        sessionId,
        mode: 'form',
        message: 'Pick your settings',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            color: {
              type: 'string',
              title: 'Color',
              oneOf: [
                { const: 'red', title: 'Red' },
                { const: 'blue', title: 'Blue' },
              ],
            },
          },
          required: ['name'],
        },
      })
      echoText('elicit-form result: ' + JSON.stringify(result))
    } catch (err) {
      echoText('elicit-form error: ' + err.message)
    }
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

  // Test directive: "elicit-url" sends a url elicitation; after the user
  // accepts, the agent signals elicitation/complete like a real OAuth flow.
  if (userText === 'elicit-url') {
    const elicitationId = 'echo-elicit-' + nextExecId++
    const echoText = (text) =>
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      })
    try {
      const result = await requestFromClient('elicitation/create', {
        sessionId,
        mode: 'url',
        message: 'Authorize the echo agent',
        url: 'https://auth.example.test/flow?token=abc',
        elicitationId,
      })
      echoText('elicit-url result: ' + JSON.stringify(result))
      if (result && result.action === 'accept') {
        notify('elicitation/complete', { elicitationId })
      }
    } catch (err) {
      echoText('elicit-url error: ' + err.message)
    }
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'end_turn' })
  }

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

  reply(id, { stopReason: 'end_turn' })
}

function handle(msg) {
  // Response to an agent-initiated request (no method)?
  if (msg.method === undefined) {
    const p = pendingClientRequests.get(msg.id)
    if (p) {
      pendingClientRequests.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
    return
  }
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
    case 'initialize': {
      // Opt-in image capability via env so image-paste/drop E2E can exercise the
      // gated path; default stays capability-free for the other smoke specs.
      const promptCapabilities = process.env.ECHO_AGENT_IMAGE === '1' ? { image: true } : {}
      return reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities,
          ...(loadSessionEnabled ? { loadSession: true } : {}),
        },
      })
    }
    case 'session/new': {
      const sessionId = 'echo-' + nextSessionId++
      sessionMcpServers.set(sessionId, msg.params?.mcpServers ?? [])
      sessionCwds.set(sessionId, msg.params?.cwd ?? '')
      if (configOptionsEnabled) sessionConfigOptionValues.set(sessionId, new Map())
      const result = configOptionsEnabled
        ? { sessionId, configOptions: buildConfigOptions(sessionId) }
        : { sessionId }
      const newDelayMs = Number(process.env.ECHO_AGENT_SESSION_NEW_DELAY_MS ?? 0)
      if (newDelayMs > 0) {
        setTimeout(() => reply(msg.id, result), newDelayMs)
        return
      }
      return reply(msg.id, result)
    }
    case 'session/set_config_option': {
      if (!configOptionsEnabled) {
        return fail(msg.id, -32601, 'Method not found: ' + msg.method)
      }
      const sessionId = msg.params?.sessionId
      const overrides = sessionConfigOptionValues.get(sessionId)
      if (!overrides) return fail(msg.id, -32602, 'session not found: ' + sessionId)
      if (typeof msg.params?.value === 'string')
        overrides.set(msg.params.configId, msg.params.value)
      return reply(msg.id, { configOptions: buildConfigOptions(sessionId) })
    }
    case 'session/load': {
      if (!loadSessionEnabled) {
        return fail(msg.id, -32601, 'Method not found: ' + msg.method)
      }
      const sessionId = msg.params?.sessionId
      // Real agents only persist a session once it has messages; loading an
      // empty session fails. The editor relies on this to discard ghost rows.
      if (!messagedSessions.has(sessionId)) {
        return fail(msg.id, -32602, 'session not found: ' + sessionId)
      }
      sessionMcpServers.set(sessionId, msg.params?.mcpServers ?? [])
      for (const turn of sessionPrompts.get(sessionId) ?? []) {
        for (const content of turn.prompt) {
          notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content,
              ...(turn.messageId ? { messageId: turn.messageId } : {}),
            },
          })
        }
      }
      return reply(msg.id, {})
    }
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
