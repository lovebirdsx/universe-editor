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
 *      routed and parse params into the expected error/response wire shape. Both
 *      forks implement these two methods (codex leaves file rollback to the
 *      editor, but the methods exist); they differ only in what a live session
 *      costs to open. The claude fork spawns its native CLI at session/new, so its
 *      routing leg runs only when a real Claude binary is reachable
 *      (CLAUDE_CODE_EXECUTABLE); the codex leg needs just its dist + bundled
 *      app-server + an in-memory provider, so it always runs when the dist is
 *      ready. The name-table + handshake legs need neither.
 *    - the editor's shared ext-method NAME table is internally consistent; and,
 *      crucially, each fork's BUILT dist still declares the wire names the editor
 *      calls — an OFFLINE text scan that runs on CI (no binary), catching a
 *      fork-side rename the binary-gated routing leg would otherwise miss;
 *    - 客户端注入模型候选 leg（`_meta.extraModels`）：新会话会把客户端给的 id 显示进
 *      model 选项。claude leg 需真实原生 CLI（session/new 会拉起它），无二进制则自跳过。
 *      注入只是往 picker 追加一行，所以本 leg 还断言一次切换真正会发生什么：无凭据时
 *      原生 CLI 校验不了该 id，以 `authentication_failed` 拒绝，且不改会话状态。真正的
 *      成功切换由同一 leg 经 `ANTHROPIC_CUSTOM_MODEL_OPTION`（CLI 自己支持的方式）覆盖，
 *      无需网关或凭据。codex leg 的 set_config_option 是纯内存状态，dist 就绪即跑。
 *
 *  The dist-dependent legs are OPT-IN via `UNIVERSE_FORK_CONTRACT=1` (set only by
 *  CI's dedicated `acp-contract` job, which runs `pnpm agent:build` first). Without
 *  the flag they skip — so a STALE local fork dist under `vendor/` (which `pnpm
 *  check` would otherwise spawn and assert against a drifted fork, failing with
 *  false negatives) never breaks a routine local run. The offline name-table check
 *  below (pure editor self-consistency, reads no fork) always runs.
 *
 *  显式启用后缺少 dist 必须失败；日志只报告运行条件，实际通过/失败/跳过以测试报告为准。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACP_EXT_METHODS,
  readCodexModelKnownInCatalog,
} from '../../src/renderer/services/acp/session/acpExtMethods.js'
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
import type { NewSessionResponse, SessionConfigOption } from '@agentclientprotocol/sdk'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

const CONTRACT_REQUIRED_FORKS = ['claude', 'codex'] as const satisfies readonly ForkId[]

const CLI_GATED_LEGS = [
  'claude ext-method wire contract (rewind_session / set_session_title)',
  'claude native model catalog + extra-model injection (session/new)',
  'claude custom-model switch (ANTHROPIC_CUSTOM_MODEL_OPTION)',
  'claude session/load replay over a synthetic transcript',
] as const

interface ForkContractCoverage {
  readonly missingDists: readonly ForkId[]
  readonly summary: string
}

function forkContractCoverage(input: {
  optedIn: boolean
  distExists: (fork: ForkId) => boolean
  claudeBinary: boolean
}): ForkContractCoverage {
  const distReady: Record<ForkId, boolean> = {
    claude: input.distExists('claude'),
    codex: input.distExists('codex'),
  }
  const readyForks = CONTRACT_REQUIRED_FORKS.filter((fork) => distReady[fork])
  const missingDists = input.optedIn
    ? CONTRACT_REQUIRED_FORKS.filter((fork) => !distReady[fork])
    : []
  const notExecuted =
    input.optedIn && distReady.claude && !input.claudeBinary ? [...CLI_GATED_LEGS] : []

  const lines = [
    `[fork-contract] opt-in (UNIVERSE_FORK_CONTRACT=1): ${input.optedIn ? 'yes' : 'no'}`,
    `[fork-contract] fork dist: claude=${distReady.claude ? 'present' : 'missing'} codex=${distReady.codex ? 'present' : 'missing'}`,
    `[fork-contract] real Claude CLI (CLAUDE_CODE_EXECUTABLE): ${input.claudeBinary ? 'present' : 'absent'}`,
    '[fork-contract] always-on: editor ext-method name table (offline, reads no fork)',
    input.optedIn
      ? `[fork-contract] dist-gated legs: enabled for ${readyForks.join(', ') || 'no fork (dist missing)'}`
      : '[fork-contract] dist-gated legs: skipped (opt-in not set)',
  ]
  if (notExecuted.length > 0) {
    lines.push(
      `[fork-contract] NOT EXECUTED — needs a real Claude binary: ${notExecuted.join(' | ')}`,
    )
  }

  return { missingDists, summary: lines.join('\n') }
}

// 测试配置隐藏通过用例的 console 输出，因此运行条件直接写 stdout。
describe('fork contract run gate', () => {
  it('prints coverage and fails when an opted-in run is missing a fork dist', () => {
    const coverage = forkContractCoverage({
      optedIn: forkContractEnabled,
      distExists: forkDistExists,
      claudeBinary: claudeBinaryAvailable(),
    })
    process.stdout.write(`\n${coverage.summary}\n`)

    expect(
      coverage.missingDists,
      `UNIVERSE_FORK_CONTRACT=1 requires a built dist for every fork; missing: ${
        coverage.missingDists.join(', ') || '(none)'
      }. Run \`pnpm agent:build\` first.`,
    ).toEqual([])
  })
})

describe('fork contract gate logic', () => {
  const coverageFor = (input: Partial<Parameters<typeof forkContractCoverage>[0]>) =>
    forkContractCoverage({ optedIn: false, distExists: () => false, claudeBinary: false, ...input })

  it('never reds a routine run when not opted in, even with no dist at all', () => {
    expect(coverageFor({}).missingDists).toEqual([])
  })

  it('reds for EVERY fork dist missing once opted in', () => {
    expect(coverageFor({ optedIn: true }).missingDists).toEqual(['claude', 'codex'])
    expect(
      coverageFor({ optedIn: true, distExists: (fork) => fork === 'claude' }).missingDists,
    ).toEqual(['codex'])
    expect(coverageFor({ optedIn: true, distExists: () => true }).missingDists).toEqual([])
  })

  it('reports the real-CLI legs as NOT EXECUTED when no binary is reachable', () => {
    const withoutCli = coverageFor({ optedIn: true, distExists: () => true, claudeBinary: false })
    expect(withoutCli.summary).toContain('NOT EXECUTED')
    for (const leg of CLI_GATED_LEGS) expect(withoutCli.summary).toContain(leg)

    const withCli = coverageFor({ optedIn: true, distExists: () => true, claudeBinary: true })
    expect(withCli.summary).not.toContain('NOT EXECUTED')
  })
})

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
    'extraModelEffort',
    // The catalog entry the editor's read-only side-task pin depends on: a
    // catalog without it silently drops the pin and the fork inherits the
    // parent's (possibly writable) mode. Scan the label, not `dontAsk` — the
    // settings alias table in permissions/modes.ts keeps that literal in the
    // dist either way, so only the label proves the entry itself survived.
    "Don't Ask",
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
    'extraModelEffort',
    // Codex-only sibling of extraModels: the resolved context window for the
    // current model, injected per-session so a gateway model absent from
    // codex's registry is not managed on its 272K fallback.
    'modelContextWindow',
    // Unlike the entries above (all client->agent request/notification or
    // request _meta), this one is the fork->editor RESPONSE _meta key the codex
    // fork reports on session/new, session/load and session/resume — the
    // authoritative "does codex know this model's own context window" verdict
    // the editor reads to gate its unknown-window warning. This scan only
    // proves the name survives somewhere in the dist (the SessionState field
    // alone satisfies it); that the fork actually REPORTS it on a session
    // response is asserted live in the extra-models leg below.
    'modelKnownInCatalog',
    // The codex side of the sub-agent trail. The editor sends the capability
    // under `clientCapabilities._meta` (the claude fork reads the same literal
    // for its flattened transcript) and reads the two `_meta.codex` keys the
    // fork stamps back: `subagent` on a `subAgentActivity` card, and
    // `parentToolCallId` on every update of a child thread. A rebase that drops
    // either reader leaves the editor with flat, unattributed sub-agent work —
    // silently, since unknown `_meta` keys are ignored — so both literals are
    // pinned here the way `extraModels` is.
    'subagent-transcript',
    'parentToolCallId',
    // The run span of a sub-agent, keyed by that same capability: the spawning
    // item settles in milliseconds while the sub-agent runs for minutes, so the
    // card's clock and duration come from this key alone (anchor on the card's
    // first report, duration at the child's turn end / summed over its turns on
    // replay). Dropping it silently strands every spawn card at `0s`.
    '_universe/subagentTiming',
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
// The extraModels legs prove it reaches the session picker's options — the
// place the forks' hardcoded catalogues would otherwise hide a gateway model.
// It is NOT a model either fork's CLI can actually serve, which is exactly what
// the claude leg's refusal assertion needs.
const EXTRA_MODEL_ID = 'contract-extra-model-v4'

// A non-first-party model id declared THROUGH THE CLI ITSELF, via its supported
// `ANTHROPIC_CUSTOM_MODEL_OPTION`. This is the "CLI-supported local controlled
// config" that lets the claude leg verify a real successful switch without a
// gateway, a credential, or a prompt.
const CLI_CUSTOM_MODEL_ID = 'contract-local-model'

/** The select values of a session config option, groups flattened. */
function configOptionValues(option: SessionConfigOption | undefined): string[] {
  if (!option || !('options' in option)) return []
  return option.options.flatMap((o) => ('options' in o ? o.options : [o])).map((o) => o.value)
}

/**
 * Codex-only offline session bootstrap: handshake, discover the configurable
 * openai provider, point the fork at a dummy gateway, then open a session.
 * Pointing at a provider is pure in-memory state and flips `authRequired()` to
 * false, so a session opens with no account, no network and no model call.
 * Shared by the extra-models leg and the ext-method contract below.
 */
async function connectCodexOfflineSession(
  connection: RealForkConnection,
  cwd: string,
  extraMeta?: Record<string, unknown>,
): Promise<NewSessionResponse> {
  await withTimeout(
    connection.conn.initialize(CLIENT_INIT_PARAMS),
    INIT_TIMEOUT_MS,
    'codex initialize',
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
  })
  // provider id 由 fork 声明；按协议发现可配置槽位，避免依赖上游的旧命名。
  const providers = await withTimeout(
    connection.conn.unstable_listProviders({}),
    CALL_TIMEOUT_MS,
    'codex listProviders',
  )
  const gatewayProvider = providers.providers.find(
    (p) => !p.required && p.supported.includes('openai'),
  )
  if (!gatewayProvider) {
    throw new Error(
      `codex advertises no configurable openai provider: ${JSON.stringify(providers.providers)}\n--- fork stderr ---\n${connection.stderr()}`,
    )
  }
  await withTimeout(
    connection.conn.unstable_setProvider({
      providerId: gatewayProvider.providerId,
      apiType: 'openai',
      baseUrl: 'https://gateway.invalid/v1',
    }),
    CALL_TIMEOUT_MS,
    'codex setProvider',
  )
  return withTimeout(
    connection.conn.newSession({
      cwd,
      mcpServers: [],
      ...(extraMeta ? { _meta: extraMeta } : {}),
    }),
    INIT_TIMEOUT_MS,
    'codex newSession',
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
  })
}

/** The JSON-RPC error a rejected wire call carried. */
interface WireError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/**
 * Await a wire call that MUST reject, and return its JSON-RPC error.
 *
 * Stricter than `rejects.toThrow(/.../)` on purpose: a numeric `code` is
 * required, so a timeout or a transport failure can never masquerade as the
 * error contract under test. stderr is attached when the shape is wrong.
 */
async function wireError(
  label: string,
  call: Promise<unknown>,
  connection: RealForkConnection,
): Promise<WireError> {
  const outcome = await call.then(
    () => undefined,
    (err: unknown) => err,
  )
  if (outcome === undefined) {
    throw new Error(`${label}: expected a rejection\n--- fork stderr ---\n${connection.stderr()}`)
  }
  const candidate = outcome as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof candidate.code !== 'number') {
    throw new Error(
      `${label}: rejected without a JSON-RPC code: ${String(outcome)}\n--- fork stderr ---\n${connection.stderr()}`,
    )
  }
  return { code: candidate.code, message: String(candidate.message), data: candidate.data }
}

/** Count of zod parse messages a parser rejection attached to `field`. */
function zodFieldErrors(data: unknown, field: string): number {
  const entry = (data as Record<string, { _errors?: unknown[] } | undefined> | undefined)?.[field]
  return entry?._errors?.length ?? 0
}

// One shared handshake suite per fork. Both forks implement the ACP handshake and
// session/new without auth. Both also implement the universe-editor/* request
// ext-methods (rewind/title — codex only leaves FILE rollback to the editor), but
// the live legs for those are split by boot cost: claude's needs a native binary,
// codex's needs only its dist, so codex's sits in its own suite below.
function handshakeSuite(fork: ForkId) {
  describe.skipIf(!distReady(fork))(`${fork} fork contract (real dist)`, () => {
    let cwd: string
    let connection: RealForkConnection

    beforeEach(() => {
      cwd = mkTempDir(`acp-contract-${fork}-`)
      connection = spawnForkConnection(fork, cwd)
    })

    afterEach(async () => {
      await connection.dispose()
      try {
        removeDirWithRetry(cwd)
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
        const ns = await connectCodexOfflineSession(connection, cwd, {
          extraModels: [EXTRA_MODEL_ID],
          extraModelEffort: [{ id: EXTRA_MODEL_ID, effortLevels: ['low', 'high'] }],
        })
        const modelOption = ns.configOptions?.find((o) => o.id === 'model')
        expect(configOptionValues(modelOption)).toContain(EXTRA_MODEL_ID)

        // The fork->editor verdict the editor gates its unknown-window warning
        // on. Asserted live because the dist text scan cannot distinguish the
        // reporter from the SessionState field of the same name: dropping just
        // the response `_meta` would still leave the literal in the bundle.
        // Only presence is asserted, not the value — the verdict describes the
        // model codex itself resolved for this session (its own default here,
        // since we pin none), and betting on which model that is would couple
        // this test to codex's default-model resolution. `undefined` is the
        // failure that matters: the editor reads it as "no verdict" and falls
        // back to its own incomplete knowledge base, which is the bug this
        // channel exists to fix.
        expect(typeof readCodexModelKnownInCatalog(ns._meta)).toBe('boolean')

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

        // The injected effort levels must reach the reasoning-effort option once
        // the gateway model is current — the `_meta.extraModelEffort` → effort
        // option leg the model-option assertion alone leaves untested.
        const effortOption = set.configOptions.find((o) => o.id === 'reasoning_effort')
        expect(configOptionValues(effortOption)).toContain('low')
        expect(configOptionValues(effortOption)).toContain('high')
      })
    }
  })
}

handshakeSuite('claude')
handshakeSuite('codex')

// Claude's live ext-method legs. The claude fork's `session/new` eagerly spawns
// the Claude native CLI, so these run only when a real binary is reachable via
// CLAUDE_CODE_EXECUTABLE (local dev with Claude installed); CI without a binary
// skips them while still enforcing the offline core above. We drive them WITHOUT
// a real prompt and assert the fork routes the method and parses its params into
// the documented error/response wire shape.
//
// Every leg here runs against a THROWAWAY `CLAUDE_CONFIG_DIR` and with the
// ambient gateway routing stripped, i.e. the CLI's NATIVE mode. Two reasons:
// the machine's own gateway/credential variables must not decide what these
// assertions observe (and a bare `sessionId`-scoped call must never be steered
// at a real gateway), and the user's real `~/.claude` must not be read or
// written by a contract test.
const claudeExtReady = distReady('claude') && claudeBinaryAvailable()

/** claude 各 leg 的原生模式子进程 env：`undefined` 表示从继承环境里删除该变量
 *  （见 `SpawnForkOptions`）。`ANTHROPIC_CUSTOM_MODEL_OPTION` 用 CLI 自己支持的
 *  方式声明一个非一方模型 id，无需任何凭据即可验证成功路径。 */
function claudeNativeEnv(configDir: string): Record<string, string | undefined> {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: undefined,
    ANTHROPIC_CUSTOM_MODEL_OPTION: CLI_CUSTOM_MODEL_ID,
  }
}

describe.skipIf(!claudeExtReady)('claude ext-method wire contract (real dist)', () => {
  let cwd: string
  let configDir: string
  let connection: RealForkConnection
  let sessionId: string

  beforeEach(async () => {
    cwd = mkTempDir('acp-contract-claude-ext-')
    configDir = mkTempDir('acp-contract-claude-config-')
    connection = spawnForkConnection('claude', cwd, { env: claudeNativeEnv(configDir) })
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

  afterEach(async () => {
    await connection.dispose()
    for (const dir of [cwd, configDir]) {
      try {
        removeDirWithRetry(dir)
      } catch {
        // best-effort
      }
    }
  })

  it('newSession returns a session id offline (no auth needed for handshake)', () => {
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('advertises dontAsk and accepts it — the read-only pin of a side task', async () => {
    // The editor pins a forked side task to `dontAsk`. A catalog that does not
    // advertise the value makes that push a no-op (the editor's config state
    // machine skips values the option does not offer) and the fork inherits
    // the parent's mode instead — the regression this leg guards.
    const ns = await withTimeout(
      connection.conn.newSession({ cwd, mcpServers: [] }),
      INIT_TIMEOUT_MS,
      'claude newSession for the mode catalog',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modeOption = ns.configOptions?.find((o) => o.id === 'mode')
    expect(configOptionValues(modeOption)).toContain('dontAsk')

    const set = await withTimeout(
      connection.conn.setSessionConfigOption({
        sessionId: ns.sessionId,
        configId: 'mode',
        value: 'dontAsk',
      }),
      CALL_TIMEOUT_MS,
      'claude setSessionConfigOption to dontAsk',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modeAfter = set.configOptions.find((o) => o.id === 'mode')
    expect(modeAfter?.currentValue).toBe('dontAsk')
  })

  it('session/new offers a client-injected extra model, but the credential-less native CLI refuses the switch', async () => {
    // 两半契约：`_meta.extraModels` 只把 id 追加进 picker；切它却要过原生 CLI 自己的
    // 目录校验，本 leg 无凭据 → 校验不了，报缺认证（authentication_failed）而非模型不存在。
    // 拒绝不能是未包装的 SDK 抛错变成的 Internal error——那会把 CLI 原文留在 details 里。
    const ns = await withTimeout(
      connection.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: {
          extraModels: [EXTRA_MODEL_ID],
          extraModelEffort: [{ id: EXTRA_MODEL_ID, effortLevels: ['low', 'high'] }],
        },
      }),
      INIT_TIMEOUT_MS,
      'claude newSession with extraModels',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modelOption = ns.configOptions?.find((o) => o.id === 'model')
    expect(configOptionValues(modelOption)).toContain(EXTRA_MODEL_ID)
    const modelBefore = modelOption?.currentValue
    expect(typeof modelBefore).toBe('string')
    const originalModelId = typeof modelBefore === 'string' ? modelBefore : 'default'

    const updatesBefore = connection.sessionUpdates.length
    const err: { code?: number; message?: string; data?: unknown } = await withTimeout(
      connection.conn.setSessionConfigOption({
        sessionId: ns.sessionId,
        configId: 'model',
        value: EXTRA_MODEL_ID,
      }),
      CALL_TIMEOUT_MS,
      'claude setSessionConfigOption to extra model',
    ).then(
      () => {
        throw new Error(
          `the native CLI accepted "${EXTRA_MODEL_ID}", a model outside its catalogue — ` +
            `the extraModels picker row is being mistaken for availability`,
        )
      },
      (e: { code?: number; message?: string; data?: unknown }) => e,
    )

    expect(err.code).toBe(-32000)
    expect(err.data).toMatchObject({ errorKind: 'authentication_failed' })
    // ACP 兜底会把 CLI 原文塞进 details；fork 必须翻译，不能回显。
    expect(err.data ?? {}).not.toHaveProperty('details')

    // 被拒就不是成功：不能有任何通知宣告模型换了。
    const advertised = connection.sessionUpdates
      .slice(updatesBefore)
      .filter((n) => n.update.sessionUpdate === 'config_option_update')
    expect(advertised).toEqual([])

    // 会话仍可继续、仍停在原模型：把原 currentValue 再设回去必须被接受并回读一致
    // （currentValue 永远是合法目标），证明这次拒绝没把会话搞坏。
    const reasserted = await withTimeout(
      connection.conn.setSessionConfigOption({
        sessionId: ns.sessionId,
        configId: 'model',
        value: originalModelId,
      }),
      CALL_TIMEOUT_MS,
      'claude setSessionConfigOption back to the original model',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    expect(reasserted.configOptions.find((o) => o.id === 'model')?.currentValue).toBe(
      originalModelId,
    )
  })

  it('switches to a non-first-party model the CLI itself declares (ANTHROPIC_CUSTOM_MODEL_OPTION)', async () => {
    // 成功的一半：同一个调用，唯一差别是这个 id 经 CLI 自己支持的 env 声明过——无网关、
    // 无凭据也能走通，证明 fork 的成功路径（配置袋 + id 逐字透传）端到端可用。
    const ns = await withTimeout(
      connection.conn.newSession({ cwd, mcpServers: [] }),
      INIT_TIMEOUT_MS,
      'claude newSession for the custom model',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    const modelOption = ns.configOptions?.find((o) => o.id === 'model')
    expect(configOptionValues(modelOption)).toContain(CLI_CUSTOM_MODEL_ID)

    const set = await withTimeout(
      connection.conn.setSessionConfigOption({
        sessionId: ns.sessionId,
        configId: 'model',
        value: CLI_CUSTOM_MODEL_ID,
      }),
      CALL_TIMEOUT_MS,
      'claude setSessionConfigOption to the CLI-declared custom model',
    ).catch((err: unknown) => {
      throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
    })
    expect(set.configOptions.find((o) => o.id === 'model')?.currentValue).toBe(CLI_CUSTOM_MODEL_ID)
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

// 合成 JSONL 只写临时 CLAUDE_CONFIG_DIR；真实 SDK / CLI 验收不发送 prompt、不读用户历史。
const SYNTH_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SYNTH_U1 = '11111111-1111-4111-8111-111111111111'
const SYNTH_A1 = '22222222-2222-4222-8222-222222222222'
const SYNTH_U2 = '33333333-3333-4333-8333-333333333333'
const SYNTH_A2 = '44444444-4444-4444-8444-444444444444'
const SYNTH_U3 = '55555555-5555-4555-8555-555555555555'

type SynthEntry = Record<string, unknown>

function synthUser(uuid: string, parentUuid: string | null, text: string): SynthEntry {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: SYNTH_SESSION_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function synthAssistant(
  uuid: string,
  parentUuid: string | null,
  apiId: string,
  text: string,
): SynthEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: SYNTH_SESSION_ID,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      id: apiId,
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function syntheticTranscript(): SynthEntry[] {
  return [
    synthUser(SYNTH_U1, null, 'contract first prompt'),
    synthAssistant(SYNTH_A1, SYNTH_U1, 'api-1', 'contract answer one'),
    synthUser(SYNTH_U2, SYNTH_A1, 'contract second prompt'),
    synthAssistant(SYNTH_A2, SYNTH_U2, 'api-2', 'contract answer two'),
    synthUser(SYNTH_U3, SYNTH_A2, 'contract third prompt'),
  ]
}

// 使用 SDK 与 fork 的历史扫描器都能识别的项目目录布局。
function writeSyntheticTranscript(configDir: string, entries: SynthEntry[]): string {
  const dir = join(configDir, 'projects', 'acp-contract-synthetic')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${SYNTH_SESSION_ID}.jsonl`)
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  return file
}

function readTranscript(file: string): SynthEntry[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SynthEntry)
}

// 锚定 fork 仅做文件操作，故只要求 dist；空 cwd 验证解析时省略 dir、跨项目查找的契约。
describe.skipIf(!distReady('claude'))(
  'claude anchored fork over a synthetic transcript (real dist)',
  () => {
    let cwd: string
    let configDir: string
    let connection: RealForkConnection
    let sourceFile: string

    async function initialize(): Promise<void> {
      await withTimeout(
        connection.conn.initialize(CLIENT_INIT_PARAMS),
        INIT_TIMEOUT_MS,
        'claude initialize',
      ).catch((err: unknown) => {
        throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
      })
    }

    async function forkAt(rewindTo: string) {
      return withTimeout(
        connection.conn.unstable_forkSession({
          sessionId: SYNTH_SESSION_ID,
          cwd: '',
          mcpServers: [],
          _meta: { rewindTo },
        }),
        CALL_TIMEOUT_MS,
        `claude unstable_forkSession (${rewindTo})`,
      )
    }

    beforeEach(() => {
      cwd = mkTempDir('acp-contract-claude-fork-')
      configDir = mkTempDir('acp-contract-claude-fork-config-')
      sourceFile = writeSyntheticTranscript(configDir, syntheticTranscript())
      connection = spawnForkConnection('claude', cwd, { env: claudeNativeEnv(configDir) })
    })

    afterEach(async () => {
      await connection.dispose()
      for (const dir of [cwd, configDir]) {
        try {
          removeDirWithRetry(dir)
        } catch {
          // 尽力清理临时目录
        }
      }
    })

    it('session/fork slices up to the anchor predecessor and leaves the source untouched', async () => {
      await initialize()
      const before = readFileSync(sourceFile)

      const forked = await forkAt(SYNTH_U3)

      expect(typeof forked.sessionId).toBe('string')
      expect(forked.sessionId).not.toBe(SYNTH_SESSION_ID)
      expect(readFileSync(sourceFile).equals(before)).toBe(true)

      const forkedFile = join(dirname(sourceFile), `${forked.sessionId}.jsonl`)
      // SDK 附加的 custom-title 是元数据，不参与消息切点断言。
      const originals = readTranscript(forkedFile)
        .filter((entry) => entry['type'] !== 'custom-title')
        .map((entry) => (entry['forkedFrom'] as { messageUuid?: string } | undefined)?.messageUuid)
      expect(originals).toEqual([SYNTH_U1, SYNTH_A1, SYNTH_U2, SYNTH_A2])
      expect(originals).not.toContain(SYNTH_U3)
    })

    it('rejects an unknown anchor with invalid-params instead of copying the whole session', async () => {
      await initialize()
      const err = await wireError(
        'claude fork unknown anchor',
        forkAt('no-such-message-id'),
        connection,
      )
      expect(err.code).toBe(-32602)
      expect(err.message).toMatch(/not found/i)
      // 拒绝后不能留下整份复制的副本。
      expect(readdirSync(dirname(sourceFile))).toEqual([`${SYNTH_SESSION_ID}.jsonl`])
    })

    it('rejects a first-message anchor that has no predecessor', async () => {
      await initialize()
      const err = await wireError('claude fork first-message anchor', forkAt(SYNTH_U1), connection)
      expect(err.code).toBe(-32602)
      expect(err.message).toMatch(/first message/i)
    })
  },
)

// load 会拉起 CLI；隔离配置与凭据，只验证回放通知，不发送 prompt。
describe.skipIf(!claudeExtReady)(
  'claude session/load replays a synthetic transcript (real dist)',
  () => {
    let cwd: string
    let configDir: string
    let connection: RealForkConnection

    beforeEach(() => {
      cwd = mkTempDir('acp-contract-claude-load-')
      configDir = mkTempDir('acp-contract-claude-load-config-')
      writeSyntheticTranscript(configDir, syntheticTranscript())
      connection = spawnForkConnection('claude', cwd, { env: claudeNativeEnv(configDir) })
    })

    afterEach(async () => {
      await connection.dispose()
      for (const dir of [cwd, configDir]) {
        try {
          removeDirWithRetry(dir)
        } catch {
          // 尽力清理临时目录
        }
      }
    })

    it('replays the inherited user turns with no prompt sent', async () => {
      await withTimeout(
        connection.conn.initialize(CLIENT_INIT_PARAMS),
        INIT_TIMEOUT_MS,
        'claude initialize',
      ).catch((err: unknown) => {
        throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
      })

      await withTimeout(
        connection.conn.loadSession({ sessionId: SYNTH_SESSION_ID, cwd, mcpServers: [] }),
        INIT_TIMEOUT_MS,
        'claude loadSession',
      ).catch((err: unknown) => {
        throw new Error(`${String(err)}\n--- fork stderr ---\n${connection.stderr()}`)
      })

      const userTexts = connection.sessionUpdates
        .filter((n) => n.update.sessionUpdate === 'user_message_chunk')
        .map((n) => JSON.stringify(n.update))
      expect(userTexts.some((text) => text.includes('contract first prompt'))).toBe(true)
      expect(userTexts.some((text) => text.includes('contract second prompt'))).toBe(true)
    })
  },
)

// Codex's live ext-method legs. Codex implements BOTH request ext-methods the
// editor calls — `rewind_session` and `set_session_title` (the older wording that
// called them "Claude-only" was wrong: codex merely leaves FILE rollback to the
// editor, which is a different thing from not having the method). Unlike claude,
// opening a codex session needs no native binary, so this suite runs whenever the
// dist is ready. Params are driven WITHOUT a prompt and asserted down to the
// JSON-RPC error code, so a fork-side change in param parsing or routing fails
// here instead of silently degrading in the editor.
describe.skipIf(!distReady('codex'))('codex ext-method wire contract (real dist)', () => {
  let cwd: string
  let connection: RealForkConnection
  let sessionId: string

  beforeEach(async () => {
    cwd = mkTempDir('acp-contract-codex-ext-')
    connection = spawnForkConnection('codex', cwd)
    const ns = await connectCodexOfflineSession(connection, cwd)
    sessionId = ns.sessionId
  })

  afterEach(async () => {
    await connection.dispose()
    try {
      removeDirWithRetry(cwd)
    } catch {
      // best-effort
    }
  })

  // SDK's zod parser rejects a missing/typed-wrong field BEFORE the handler runs,
  // and its `data` names the offending key — that shape is what distinguishes a
  // params-contract failure from a handler failure.
  it('set_session_title rejects a missing title with a param-parser invalid-params', async () => {
    const err = await wireError(
      'set_session_title missing title',
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.setSessionTitle, { sessionId }),
        CALL_TIMEOUT_MS,
        'codex set_session_title',
      ),
      connection,
    )
    expect(err.code).toBe(-32602)
    expect(zodFieldErrors(err.data, 'title')).toBeGreaterThan(0)
  })

  it('set_session_title rejects a whitespace-only title in the handler', async () => {
    const err = await wireError(
      'set_session_title whitespace title',
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.setSessionTitle, {
          sessionId,
          title: '   ',
        }),
        CALL_TIMEOUT_MS,
        'codex set_session_title whitespace',
      ),
      connection,
    )
    // Same code as the parser path, but a bare handler-thrown invalidParams: no
    // parser `data`. Keeping the two apart is the point of asserting `data`.
    expect(err.code).toBe(-32602)
    expect(err.data).toBeUndefined()
  })

  it('rewind_session rejects a missing messageId with a param-parser invalid-params', async () => {
    const err = await wireError(
      'rewind_session missing messageId',
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.rewindSession, { sessionId, dryRun: true }),
        CALL_TIMEOUT_MS,
        'codex rewind_session',
      ),
      connection,
    )
    expect(err.code).toBe(-32602)
    expect(zodFieldErrors(err.data, 'messageId')).toBeGreaterThan(0)
  })

  it('rewind_session with valid params for an unknown session reaches the handler', async () => {
    const unknownSessionId = 'no-such-session'
    const err = await wireError(
      'rewind_session unknown session',
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.rewindSession, {
          sessionId: unknownSessionId,
          messageId: 'anchor',
          dryRun: true,
        }),
        CALL_TIMEOUT_MS,
        'codex rewind_session unknown session',
      ),
      connection,
    )
    // -32603, not -32601: the request routed and parsed, and it is the handler's
    // own session lookup that failed — the precise "you reached the handler"
    // contract. A typo'd method name or a dropped registration would be -32601.
    expect(err.code).toBe(-32603)
    expect(err.data).toMatchObject({ details: `Session ${unknownSessionId} not found` })
  })

  // LIMITATION (measured, not assumed): the bundled app-server cannot read an
  // empty thread's turns yet, so `dryRun` — which reads the thread to test the
  // anchor — fails with an internal error instead of returning the
  // `{canRewind:false}` that a live history produces for an unknown anchor.
  // There is no way to get turns without sending a prompt, which this suite must
  // not do, so the limitation is pinned exactly rather than asserted loosely.
  // If the app-server gains turn reads, replace this with the `{canRewind:false}`
  // check for a non-existent anchor.
  it('rewind_session dryRun on a session with no turns surfaces the known app-server limitation', async () => {
    const err = await wireError(
      'rewind_session empty session dryRun',
      withTimeout(
        connection.conn.extMethod(ACP_EXT_METHODS.rewindSession, {
          sessionId,
          messageId: 'no-such-message',
          dryRun: true,
        }),
        CALL_TIMEOUT_MS,
        'codex rewind_session empty session',
      ),
      connection,
    )
    expect(err.code).toBe(-32603)
    expect((err.data as { details?: string } | undefined)?.details).toMatch(
      /list_turns is not supported/,
    )
  })
})
