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
 * The five custom ACP ext-methods / notifications shared with the agent forks.
 * Direction annotates who initiates the JSON-RPC call:
 *  - `client->agent`: the editor calls the fork (request/response).
 *  - `agent->client`: the fork calls the editor (surfaced on the client handler).
 */
export const ACP_EXT_METHODS = {
  /** agent->client request: AskUserQuestion round-trip (fork interactive.ts). */
  askUserQuestion: 'universe-editor/ask_user_question',
  /** client->agent request: persist an AI-generated session title (renameSession). */
  setSessionTitle: 'universe-editor/set_session_title',
  /** client->agent request: rewind a session to a user message (files + history). */
  rewindSession: 'universe-editor/rewind_session',
  /** agent->client notification: context-compaction lifecycle (start/success/failed). */
  compaction: '_universe/compaction',
  /** agent->client notification: raw Claude SDK message passthrough (init snapshot). */
  sdkMessage: '_claude/sdkMessage',
} as const

export type AcpExtMethodName = (typeof ACP_EXT_METHODS)[keyof typeof ACP_EXT_METHODS]

/**
 * `_meta` capability keys the editor stamps onto handshake / session requests
 * that the forks read. The contract test asserts the forks still honour these.
 */
export const ACP_META_KEYS = {
  /** clientCapabilities._meta flag advertising AskUserQuestion support. */
  askUserQuestionCapability: 'universe-editor/ask_user_question',
  /** session/new + session/load _meta asking the fork to emit raw SDK init message. */
  emitRawSdkMessages: 'claudeCode.emitRawSDKMessages',
  /** usage_update _meta carrying the per-model cost breakdown. */
  modelBreakdown: '_universe/modelBreakdown',
  /** tool_call_update _meta carrying per-sub-agent token tally. */
  subagentStats: '_universe/subagentStats',
} as const
