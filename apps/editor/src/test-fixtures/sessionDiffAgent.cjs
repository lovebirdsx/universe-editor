#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session-diff agent fixture — a minimal ACP-compatible JSON-RPC server over
 *  stdio that drives the "Session Changes" UI end to end:
 *    - on prompt, writes a real file to the OS temp dir (the agent fork writes
 *      directly to disk, bypassing the host fs gateway — the tracker reads the
 *      on-disk content and reverse-applies the patch to recover the baseline);
 *    - then emits one completed `Write` tool_call carrying the Claude SDK
 *      `_meta.claudeCode.toolResponse.{filePath, structuredPatch}` shape (see
 *      vendor/claude-agent-acp/src/acp-agent.ts PostToolUse hook), so the
 *      renderer's SessionChangeTrackerService records a whole-file change;
 *    - ends the turn.
 *
 *  Used by smoke.sessionChanges.spec to verify the full data path
 *  (agent → structuredPatch → tracker → Side Bar list → whole-file diff editor).
 *
 *  Committed as plain JS so it can be spawned via `node sessionDiffAgent.cjs`
 *  with no build step.
 *--------------------------------------------------------------------------------------------*/

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

let buffer = ''
let nextSessionId = 1

// The tracked file lives in the shared os.tmpdir(), and every agent process hands
// out the same `sd-1` sessionId — so a fixed filename would collide across the
// concurrent Electron instances Playwright runs (and with orphaned agents that
// outlive teardown on Windows), letting one test's write clobber the file another
// test's tracker reads back. Scope the path to this process with a per-run token
// so each instance owns its own file.
const RUN_TOKEN = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
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

  // The prompt text drives which edit we emit, so a spec can trigger a *second*
  // distinct change to the same file (to verify an already-open diff tab
  // refreshes in place). Default is the first edit.
  const promptText = extractPromptText(params)
  const second = promptText.includes('again')

  const filePath = path.join(os.tmpdir(), `universe-e2e-sessiondiff-${RUN_TOKEN}-${sessionId}.txt`)
  // 1. Write the post-edit file to disk (the tracker reads this as `current`).
  const current = second ? 'line one\nline two MODIFIED AGAIN' : 'line one\nline two MODIFIED'
  fs.writeFileSync(filePath, current, 'utf8')

  // 2. Emit a completed Write tool_call carrying the structuredPatch. Reversing
  //    the hunk recovers baseline "line one\nline two" → status modified. The
  //    second turn uses a distinct toolCallId + newer text so the tracker
  //    recomputes to a different `current`.
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: second ? 'sd-write-2' : 'sd-write',
      title: 'Write',
      kind: 'edit',
      status: 'completed',
      _meta: {
        claudeCode: {
          toolName: 'Write',
          toolResponse: {
            filePath,
            structuredPatch: [
              second
                ? {
                    oldStart: 1,
                    oldLines: 2,
                    newStart: 1,
                    newLines: 2,
                    lines: [' line one', '-line two', '+line two MODIFIED AGAIN'],
                  }
                : {
                    oldStart: 1,
                    oldLines: 2,
                    newStart: 1,
                    newLines: 2,
                    lines: [' line one', '-line two', '+line two MODIFIED'],
                  },
            ],
          },
        },
      },
    },
  })

  await delay(5)
  if (turn.cancelled) {
    activeTurns.delete(sessionId)
    return reply(id, { stopReason: 'cancelled' })
  }

  activeTurns.delete(sessionId)
  reply(id, { stopReason: 'end_turn' })
}

/** Pull plain text out of an ACP prompt param (array of content blocks). */
function extractPromptText(params) {
  const blocks = Array.isArray(params.prompt) ? params.prompt : []
  return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ')
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
      return reply(msg.id, { sessionId: 'sd-' + nextSessionId++ })
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
      process.stderr.write('sessionDiffAgent: bad json: ' + err.message + ' :: ' + line + '\n')
    }
  }
})

process.stdin.on('end', () => process.exit(0))
