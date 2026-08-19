/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the custom ACP ext-method names and `_meta` stamps
 *  the editor shares with the agent forks (vendor/claude-agent-acp,
 *  vendor/codex-acp). These strings are duplicated verbatim in each fork's source
 *  and were previously kept in sync by hand-written "keep both in sync" comments
 *  with zero automated verification.
 *
 *  Collecting them here lets the cross-repo contract test
 *  (__tests__/acpForkContract.integration.test.ts) assert the wire shape against
 *  the REAL fork dist, so a drift on either side fails CI instead of silently
 *  breaking chat features. Production code re-exports the individual names from
 *  acpSessionModel.ts / acpSessionService.ts for readability; those re-exports and
 *  this table are asserted equal by the contract test, so there is exactly one
 *  authoritative definition.
 *--------------------------------------------------------------------------------------------*/

/**
 * The custom ACP ext-methods / notifications shared with the agent forks.
 * Direction annotates who initiates the JSON-RPC call:
 *  - `client->agent`: the editor calls the fork (request/response).
 *  - `agent->client`: the fork calls the editor (surfaced on the client handler).
 *
 * (AskUserQuestion used to live here as `universe-editor/ask_user_question`;
 * it moved to the standard UNSTABLE elicitation channel once the editor
 * declared `elicitation.form`. The forks keep their ext-method fallback for
 * other clients — the editor no longer does.)
 */
export const ACP_EXT_METHODS = {
  /** client->agent request: persist an AI-generated session title (renameSession). */
  setSessionTitle: 'universe-editor/set_session_title',
  /** client->agent request: rewind a session to a user message (files + history). */
  rewindSession: 'universe-editor/rewind_session',
  /** agent->client notification: context-compaction lifecycle (start/success/failed). */
  compaction: '_universe/compaction',
  /** agent->client notification: wedged-session resurrection lifecycle (start/success/failed). */
  sessionResurrection: '_universe/sessionResurrection',
  /**
   * agent->client notification: content-free proof of life (codex fork's
   * liveness probe). The SDK zod-validates session/update against the
   * SessionUpdate union — a private variant there is rejected before reaching
   * any handler, so the ping travels as a custom notification instead. Params:
   * `{ sessionId }`; the editor only resets the stall watchdog's silence
   * window, no timeline entry.
   */
  livenessPing: '_universe/liveness_ping',
  /**
   * agent->client notification: background-activity snapshot. When a turn ends
   * with `run_in_background` tasks still in flight the prompt RPC settles while
   * work continues, so the fork reports `{ sessionId, backgroundTasks,
   * autonomousTurn }` — the editor keeps the session visibly active instead of
   * declaring it idle. `autonomousTurn` marks a follow-up turn (started by a
   * task-completion wakeup) that occupies no prompt RPC; it must count as
   * running. Value-deduplicated by the fork; a forced snapshot follows
   * session/load and session/resume.
   */
  backgroundActivity: '_universe/background_activity',
  /**
   * agent->client notification: MCP server startup outcome (codex fork). The
   * editor seeds every configured server as `pending` in the MCP panel; claude
   * refreshes it from the SDK system-init passthrough, codex has no equivalent
   * so its fork forwards the startup result — ready servers included, which
   * the startup-failure tool_call cards never mention. Params:
   * `{ sessionId, servers: Array<{ name, status }> }` with status one of
   * `connected` | `failed` | `cancelled`.
   */
  mcpServerStatus: '_universe/mcp_server_status',
  /** agent->client notification: raw Claude SDK message passthrough (init snapshot). */
  sdkMessage: '_claude/sdkMessage',
} as const

export type AcpExtMethodName = (typeof ACP_EXT_METHODS)[keyof typeof ACP_EXT_METHODS]

/**
 * `_meta` capability keys the editor stamps onto handshake / session requests
 * that the forks read. The contract test asserts the forks still honour these.
 */
export const ACP_META_KEYS = {
  /** session/new + session/load _meta asking the fork to emit raw SDK init message. */
  emitRawSdkMessages: 'claudeCode.emitRawSDKMessages',
  /**
   * session/load + session/resume _meta carrying the editor's per-session model
   * memory (the user's in-session pick, context-lane spelling intact, e.g.
   * "claude-fable-5[1m]"). A resume restores the bare API name from the
   * transcript — dropping "[1m]" and clamping the effective window to 200k —
   * so the fork re-asserts this remembered spelling on load.
   */
  resumeModel: 'claudeCode.resumeModel',
  /** usage_update _meta carrying the per-model cost breakdown. */
  modelBreakdown: '_universe/modelBreakdown',
  /** tool_call_update _meta carrying per-sub-agent token tally. */
  subagentStats: '_universe/subagentStats',
} as const

/**
 * Key under `initialize` → `agentCapabilities._meta` where a fork advertises which
 * `universe-editor/*` ext-capabilities it implements. Replaces the old hardcoded
 * `agentId === 'claude-code'|'codex'` white-list: any agent (including user-defined
 * ones) that declares the capability lights up the affordance. The forks copy this
 * literal verbatim; the contract test asserts both sides agree.
 */
export const ACP_CAPABILITIES_META_KEY = 'universe-editor/capabilities'

/**
 * Key under `initialize` → `clientCapabilities._meta` the editor stamps so the
 * claude fork forwards sub-agent text/thinking chunks (each tagged
 * `_meta.claudeCode.parentToolUseId`, mounted as children of the parent Task
 * card). The fork copies this literal verbatim; without it those chunks are
 * stripped, while tool calls always pass through regardless.
 */
export const SUBAGENT_TRANSCRIPT_CAPABILITY = 'subagent-transcript'

/**
 * Shape of `agentCapabilities._meta['universe-editor/capabilities']`. All fields
 * optional — an agent that omits `rewind` simply doesn't support rewind.
 */
export interface AcpUniverseCapabilities {
  /**
   * The agent implements `universe-editor/rewind_session`. `filesRolledBackByAgent`
   * says whether the agent rolls the working-tree edits back itself (claude:
   * SDK file-checkpointing) or only truncates history and leaves file rollback to
   * the client's change tracker (codex).
   */
  readonly rewind?: {
    readonly filesRolledBackByAgent: boolean
  }
}
