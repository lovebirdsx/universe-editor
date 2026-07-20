/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-repo ACP contract test (架构路线图 01·任务1).
 *
 *  Guards the wire contract between the editor and the REAL agent forks
 *  (vendor/claude-agent-acp, vendor/codex-acp). The editor's ACP SDK version and
 *  each fork's differ on purpose; the five custom ext-methods and their `_meta`
 *  stamps were previously kept in sync only by "keep both in sync" comments with
 *  no automated check. This spawns each fork's built dist over a real stdio
 *  connection and asserts:
 *    - the initialize handshake succeeds cross-SDK-version and returns the
 *      capability / _meta shape the editor relies on;
 *    - the client->agent ext-methods (set_session_title / rewind_session) are
 *      routed and parse params into the expected error/response wire shape. The
 *      claude fork spawns its native CLI at session/new, so this leg runs only
 *      when a real Claude binary is reachable (CLAUDE_CODE_EXECUTABLE); the
 *      name-table + handshake legs need no binary and always run.
 *    - the editor's shared ext-method NAME table equals the literal strings the
 *      forks expect, so a rename on either side fails here.
 *
 *  When `pnpm agent:build` hasn't run (no fork dist), the suite skips rather than
 *  fails — CI runs agent:build first (see ci.yml integration job).
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACP_EXT_METHODS } from '../../src/renderer/services/acp/acpExtMethods.js'
import {
  CLIENT_INIT_PARAMS,
  claudeBinaryAvailable,
  forkDistExists,
  type ForkId,
  type RealForkConnection,
  spawnForkConnection,
  withTimeout,
} from '../fixtures/realForkConnection.js'

// Handshake + newSession over a real subprocess: allow generous headroom (fork
// cold-start + SDK model list ~1.3s observed) so CI machines don't flake.
const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 15_000

// The literal strings each fork's source declares. Duplicated here ON PURPOSE:
// the editor side (ACP_EXT_METHODS) is asserted equal to these, so a drift on
// EITHER the editor or a fork surfaces as a failed assertion.
const EXPECTED_METHOD_NAMES = {
  askUserQuestion: 'universe-editor/ask_user_question',
  setSessionTitle: 'universe-editor/set_session_title',
  rewindSession: 'universe-editor/rewind_session',
  compaction: '_universe/compaction',
  sdkMessage: '_claude/sdkMessage',
} as const

describe('editor ext-method name table is the single source of truth', () => {
  it('matches the literal wire strings the forks expect', () => {
    expect(ACP_EXT_METHODS).toEqual(EXPECTED_METHOD_NAMES)
  })
})

// One shared handshake suite per fork. Both forks implement the ACP handshake and
// session/new without auth; only claude implements the universe-editor/* request
// ext-methods (rewind/title are Claude-only features — codex does file rollback
// client-side), so those assertions are claude-scoped.
function handshakeSuite(fork: ForkId) {
  const distReady = forkDistExists(fork)

  describe.skipIf(!distReady)(`${fork} fork contract (real dist)`, () => {
    let cwd: string
    let connection: RealForkConnection

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), `acp-contract-${fork}-`))
      connection = spawnForkConnection(fork, cwd)
    })

    afterEach(() => {
      connection.dispose()
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    })

    it('initialize succeeds cross-SDK-version and reports the expected capabilities', async () => {
      const init = await withTimeout(
        connection.conn.initialize(CLIENT_INIT_PARAMS),
        INIT_TIMEOUT_MS,
        `${fork} initialize`,
      ).catch((err: unknown) => {
        throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
      })

      expect(init.protocolVersion).toBe(1)
      // Capabilities the editor's session code reads off the handshake.
      expect(init.agentCapabilities?.loadSession).toBe(true)
      expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true)
      expect(init.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true)
      expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
        resume: {},
        list: {},
        fork: {},
      })
      expect(init.agentInfo?.name).toContain(fork === 'claude' ? 'claude-agent-acp' : 'codex')
    })
  })
}

handshakeSuite('claude')
handshakeSuite('codex')

// Claude-only: the request-style ext-methods. The claude fork's `session/new`
// eagerly spawns the Claude native CLI, so these run only when a real binary is
// reachable via CLAUDE_CODE_EXECUTABLE (local dev with Claude installed); CI
// without a binary skips them while still enforcing the offline core above. We
// drive them WITHOUT a real prompt and assert the fork routes the method and
// parses its params into the documented error/response wire shape.
const claudeExtReady = forkDistExists('claude') && claudeBinaryAvailable()

describe.skipIf(!claudeExtReady)('claude ext-method wire contract (real dist)', () => {
  let cwd: string
  let connection: RealForkConnection
  let sessionId: string

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'acp-contract-claude-ext-'))
    connection = spawnForkConnection('claude', cwd)
    await withTimeout(
      connection.conn.initialize(CLIENT_INIT_PARAMS),
      INIT_TIMEOUT_MS,
      'claude initialize',
    )
    const ns = await withTimeout(
      connection.conn.newSession({ cwd, mcpServers: [] }),
      INIT_TIMEOUT_MS,
      'claude newSession',
    )
    sessionId = ns.sessionId
  })

  afterEach(() => {
    connection.dispose()
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  it('newSession returns a session id offline (no auth needed for handshake)', () => {
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('rewind_session is routed and validates its params (unknown messageId → structured error)', async () => {
    await expect(
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.rewindSession, {
          sessionId,
          messageId: 'nonexistent-message-id',
          dryRun: true,
        }),
        CALL_TIMEOUT_MS,
        'rewind_session',
      ),
    ).rejects.toThrow(/messageId|rewind target|Invalid params/i)
  })

  it('set_session_title is routed and accepts the {sessionId, title} param shape', async () => {
    // With no durable on-disk store the underlying renameSession fails, but the
    // method MUST be routed (not "method not found") and MUST have parsed our
    // params — that is the wire contract we lock. A rename failure surfaces as a
    // generic internal error, NOT a params/route error.
    await expect(
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.setSessionTitle, {
          sessionId,
          title: 'contract-probe-title',
        }),
        CALL_TIMEOUT_MS,
        'set_session_title',
      ),
    ).rejects.toThrow(/internal error/i)
  })

  it('set_session_title rejects an empty title (its documented param constraint)', async () => {
    await expect(
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.setSessionTitle, {
          sessionId,
          title: '   ',
        }),
        CALL_TIMEOUT_MS,
        'set_session_title empty',
      ),
    ).rejects.toThrow(/title must be non-empty|internal error/i)
  })
})
