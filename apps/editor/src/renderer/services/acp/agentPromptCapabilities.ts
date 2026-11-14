/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Which agents accept prompt material through ACP `_meta` rather than inline.
 *  Keyed by the bundled fork entry (`nodeEntry`) instead of the agent id: a
 *  user entry that overrides a built-in id is an arbitrary command and must
 *  never inherit the fork's wire contract.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpAgentDescriptor } from './acpAgentRegistry.js'

export interface AgentPromptCapabilities {
  /**
   * `session/new` / `session/load` / `session/resume` accept a top-level
   * `_meta.systemPrompt: { append }` that is appended to the agent's preset
   * system prompt.
   */
  readonly systemPromptAppend: boolean
}

const NO_PROMPT_CAPABILITIES: AgentPromptCapabilities = { systemPromptAppend: false }

/** Per bundled fork. Extend here when another entry learns a prompt capability. */
const BUILT_IN_PROMPT_CAPABILITIES: Readonly<
  Record<NonNullable<IAcpAgentDescriptor['nodeEntry']>, AgentPromptCapabilities>
> = {
  claude: { systemPromptAppend: true },
  // The codex fork ignores unknown `_meta` keys, so sending the append would
  // silently do nothing. Keep its contract inline.
  codex: { systemPromptAppend: false },
}

export function agentPromptCapabilities(descriptor: IAcpAgentDescriptor): AgentPromptCapabilities {
  if (descriptor.nodeEntry === undefined) return NO_PROMPT_CAPABILITIES
  return BUILT_IN_PROMPT_CAPABILITIES[descriptor.nodeEntry]
}

export function supportsSystemPromptAppend(descriptor: IAcpAgentDescriptor): boolean {
  return agentPromptCapabilities(descriptor).systemPromptAppend
}
