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
 *    - the editor's shared ext-method NAME table is internally consistent; and,
 *      crucially, each fork's BUILT dist still declares the wire names the editor
 *      calls — an OFFLINE text scan that runs on CI (no binary), catching a
 *      fork-side rename the binary-gated routing leg would otherwise miss.
 *
 *  The dist-dependent legs are OPT-IN via `UNIVERSE_FORK_CONTRACT=1` (set only by
 *  CI's dedicated `acp-contract` job, which runs `pnpm agent:build` first). Without
 *  the flag they skip — so a STALE local fork dist under `vendor/` (which `pnpm
 *  check` would otherwise spawn and assert against a drifted fork, failing with
 *  false negatives) never breaks a routine local run. The offline name-table check
 *  below (pure editor self-consistency, reads no fork) always runs.
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
  readForkDist,
  type RealForkConnection,
  spawnForkConnection,
  withTimeout,
} from '../fixtures/realForkConnection.js'

// Handshake + newSession over a real subprocess: allow generous headroom (fork
// cold-start + SDK model list ~1.3s observed) so CI machines don't flake.
const INIT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 15_000

// The dist-dependent legs spawn / text-scan the REAL built fork dist. They run
// ONLY when explicitly opted in — CI's `acp-contract` job sets this after a fresh
// `pnpm agent:build`. Locally (and in the plain `integration` job) the flag is
// unset, so a stale fork dist under `vendor/` can't fail `pnpm check` with false
// drift.
const forkContractEnabled = process.env.UNIVERSE_FORK_CONTRACT === '1'
const distReady = (fork: ForkId): boolean => forkContractEnabled && forkDistExists(fork)

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

// The ext-method wire names each fork's BUILT dist must still declare. This is
// what the name-table assertion above CANNOT catch: that table only proves the
// editor is self-consistent (ACP_EXT_METHODS === a literal copy in this file);
// neither side reads the fork. A fork-side rename (bad rebase, typo) would slip
// through until the live routing probe caught it — but that probe needs a real
// Claude binary and self-skips on CI. Scanning the dist text closes that gap
// OFFLINE (no spawn, no binary), so CI fails the instant a fork drops/renames a
// method the editor still calls.
//
// claude declares all five; codex only the two client->agent request methods it
// implements (rewind/set_title — it does file rollback client-side and has no
// compaction / sdkMessage / ask_user_question surface).
const EXPECTED_DIST_METHODS: Record<ForkId, readonly string[]> = {
  claude: [
    EXPECTED_METHOD_NAMES.askUserQuestion,
    EXPECTED_METHOD_NAMES.setSessionTitle,
    EXPECTED_METHOD_NAMES.rewindSession,
    EXPECTED_METHOD_NAMES.compaction,
    EXPECTED_METHOD_NAMES.sdkMessage,
    // Both forks advertise universe-editor/* capabilities under the same key.
    'universe-editor/capabilities',
  ],
  codex: [
    EXPECTED_METHOD_NAMES.setSessionTitle,
    EXPECTED_METHOD_NAMES.rewindSession,
    'universe-editor/capabilities',
  ],
}

describe('fork dist declares the ext-method wire names the editor expects', () => {
  for (const fork of ['claude', 'codex'] as const) {
    describe.skipIf(!distReady(fork))(fork, () => {
      const dist = distReady(fork) ? readForkDist(fork) : ''
      for (const method of EXPECTED_DIST_METHODS[fork]) {
        it(`declares ${method}`, () => {
          expect(dist).toContain(method)
        })
      }
    })
  }
})

// One shared handshake suite per fork. Both forks implement the ACP handshake and
// session/new without auth; only claude implements the universe-editor/* request
// ext-methods (rewind/title are Claude-only features — codex does file rollback
// client-side), so those assertions are claude-scoped.
function handshakeSuite(fork: ForkId) {
  describe.skipIf(!distReady(fork))(`${fork} fork contract (real dist)`, () => {
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
      // universe-editor/* capability advertisement (replaces the editor's old
      // agentId white-list). Both forks implement rewind; they differ on whether
      // the agent rolls files back itself (claude) or leaves it to the client
      // (codex). The editor reads this exact shape in acpSession.attachConnection.
      const universeCaps = (
        init.agentCapabilities?._meta as
          | { 'universe-editor/capabilities'?: { rewind?: { filesRolledBackByAgent?: boolean } } }
          | undefined
      )?.['universe-editor/capabilities']
      expect(universeCaps?.rewind?.filesRolledBackByAgent).toBe(fork === 'claude')
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
const claudeExtReady = distReady('claude') && claudeBinaryAvailable()

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
