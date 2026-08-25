/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-repo ACP contract test (架构路线图 01·任务1).
 *
 *  Guards the wire contract between the editor and the REAL agent forks
 *  (vendor/claude-agent-acp, vendor/codex-acp). The editor's ACP SDK version and
 *  each fork's differ on purpose; the custom ext-methods and their `_meta`
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
 *      fork-side rename the binary-gated routing leg would otherwise miss;
 *    - the client-injected model candidates leg (`_meta.extraModels`): a fresh
 *      session opened with a client-supplied model id surfaces that id in the
 *      model config option and accepts `session/set_config_option` to it. The
 *      claude leg needs its native CLI (session/new spawns it) and self-skips
 *      without one; the codex leg's set_config_option is pure in-memory state
 *      and runs whenever its dist is ready.
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
import { ACP_EXT_METHODS } from '../../src/renderer/services/acp/session/acpExtMethods.js'
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
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

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
  setSessionTitle: 'universe-editor/set_session_title',
  rewindSession: 'universe-editor/rewind_session',
  subscriptionUsage: 'universe-editor/subscription_usage',
  consumeResetCredit: 'universe-editor/consume_reset_credit',
  compaction: '_universe/compaction',
  sessionResurrection: '_universe/sessionResurrection',
  livenessPing: '_universe/liveness_ping',
  backgroundActivity: '_universe/background_activity',
  mcpServerStatus: '_universe/mcp_server_status',
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
// claude declares the request methods it implements; codex declares the
// client->agent request methods it implements (rewind/set_title — it does file
// rollback client-side and has no compaction / sdkMessage surface) plus the
// liveness ping notification its stall-watchdog probe forwards. Both answer
// subscription_usage for the usage indicator; only codex can redeem a
// rate-limit reset credit (claude's plan has no equivalent). The forks'
// ask_user_question ext-method is their own fallback asset — the editor no
// longer calls it (AskUserQuestion now flows over the standard elicitation
// channel), so it's not asserted here.
//
// `extraModels` is not an ext-method but the top-level `_meta` key both forks
// read when opening a session (the editor's gateway-model injection channel).
// The property access keeps the literal in the built dist, so scanning it
// catches a rebase that drops the reader — the same protection the method
// names get.
const EXPECTED_DIST_METHODS: Record<ForkId, readonly string[]> = {
  claude: [
    EXPECTED_METHOD_NAMES.setSessionTitle,
    EXPECTED_METHOD_NAMES.rewindSession,
    EXPECTED_METHOD_NAMES.subscriptionUsage,
    EXPECTED_METHOD_NAMES.compaction,
    EXPECTED_METHOD_NAMES.sessionResurrection,
    EXPECTED_METHOD_NAMES.backgroundActivity,
    EXPECTED_METHOD_NAMES.sdkMessage,
    // Both forks advertise universe-editor/* capabilities under the same key.
    'universe-editor/capabilities',
    'extraModels',
  ],
  codex: [
    EXPECTED_METHOD_NAMES.setSessionTitle,
    EXPECTED_METHOD_NAMES.rewindSession,
    EXPECTED_METHOD_NAMES.subscriptionUsage,
    EXPECTED_METHOD_NAMES.consumeResetCredit,
    EXPECTED_METHOD_NAMES.livenessPing,
    // MCP startup outcome notification — flips the editor MCP panel's
    // config-seeded "pending" rows (claude covers this via sdkMessage instead).
    EXPECTED_METHOD_NAMES.mcpServerStatus,
    'universe-editor/capabilities',
    'extraModels',
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

// A model id that exists in NEITHER fork's hardcoded first-party catalogue.
// The extraModels legs prove it still reaches the session picker's options and
// passes `session/set_config_option` validation — the two places the forks'
// hardcoded catalogues would otherwise reject a gateway model.
const EXTRA_MODEL_ID = 'contract-extra-model-v4'

/** The select values of a session config option, groups flattened. */
function configOptionValues(option: SessionConfigOption | undefined): string[] {
  if (!option || !('options' in option)) return []
  return option.options.flatMap((o) => ('options' in o ? o.options : [o])).map((o) => o.value)
}

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

    // Codex-only: session/new + set_config_option accept client-injected extra
    // models. Unlike the claude fork (whose session/new spawns the native CLI),
    // the codex leg needs only its built dist + bundled app-server binary, and
    // set_config_option mutates pure in-memory session state — no network.
    if (fork === 'codex') {
      it('session/new surfaces client-injected extra models and accepts switching to one', async () => {
        await withTimeout(
          connection.conn.initialize(CLIENT_INIT_PARAMS),
          INIT_TIMEOUT_MS,
          'codex initialize (extra models leg)',
        ).catch((err: unknown) => {
          throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
        })
        // Configuring the gateway provider is pure in-memory state; it also
        // flips authRequired() to false so the session open passes without any
        // account on the test machine.
        await withTimeout(
          connection.conn.unstable_setProvider({
            providerId: 'custom-gateway',
            apiType: 'openai',
            baseUrl: 'https://gateway.invalid/v1',
          }),
          CALL_TIMEOUT_MS,
          'codex setProvider',
        )
        const ns = await withTimeout(
          connection.conn.newSession({
            cwd,
            mcpServers: [],
            _meta: { extraModels: [EXTRA_MODEL_ID] },
          }),
          INIT_TIMEOUT_MS,
          'codex newSession with extraModels',
        ).catch((err: unknown) => {
          throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
        })
        const modelOption = ns.configOptions?.find((o) => o.id === 'model')
        expect(configOptionValues(modelOption)).toContain(EXTRA_MODEL_ID)

        const set = await withTimeout(
          connection.conn.setSessionConfigOption({
            sessionId: ns.sessionId,
            configId: 'model',
            value: EXTRA_MODEL_ID,
          }),
          CALL_TIMEOUT_MS,
          'codex setSessionConfigOption to extra model',
        ).catch((err: unknown) => {
          throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
        })
        expect(set.configOptions.find((o) => o.id === 'model')?.currentValue).toBe(EXTRA_MODEL_ID)
      })
    }
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

  it('session/new surfaces client-injected extra models and setSessionConfigOption switches to one', async () => {
    // The SDK's picker is the hardcoded first-party catalogue; a gateway model
    // id must arrive via `_meta.extraModels` (appended after the allowlist) and
    // then pass setSessionConfigOption's options validation.
    const ns = await withTimeout(
      connection.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: { extraModels: [EXTRA_MODEL_ID] },
      }),
      INIT_TIMEOUT_MS,
      'claude newSession with extraModels',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modelOption = ns.configOptions?.find((o) => o.id === 'model')
    expect(configOptionValues(modelOption)).toContain(EXTRA_MODEL_ID)

    const set = await withTimeout(
      connection.conn.setSessionConfigOption({
        sessionId: ns.sessionId,
        configId: 'model',
        value: EXTRA_MODEL_ID,
      }),
      CALL_TIMEOUT_MS,
      'claude setSessionConfigOption to extra model',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modelAfter = set.configOptions.find((o) => o.id === 'model')
    expect(modelAfter?.currentValue).toBe(EXTRA_MODEL_ID)
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
