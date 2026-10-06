/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Claude plan-mode permission policy — the editor-side three-way switch that
 *  replaced the old two-level scoped/unscoped auto-approval pair. Pure helpers
 *  only (no DI beyond the configuration service the caller passes in), so both
 *  the session facade and the settings panel can share one definition.
 *
 *  The policy is personal: it is read from (and only from) the User layer, so a
 *  workspace / project / memory value can never widen or narrow it.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, type IConfigurationService } from '@universe-editor/platform'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

/** The built-in Claude agent this policy is scoped to. Codex and third parties are untouched. */
export const CLAUDE_AGENT_ID = 'claude-code'

/**
 * Personal configuration key. Deliberately under the `agentSettings.` namespace:
 * the switch is a Claude *agent* setting the editor owns, not a runtime knob of
 * the ACP protocol layer, and it is never written to `~/.claude/settings.json`.
 */
export const PLAN_PERMISSION_POLICY_KEY = 'agentSettings.claude.planPermissionPolicy'

/**
 * - `skip` (default): the client answers a plan-mode permission request itself
 *   with the one-shot "yes, once" option; no rule is ever written. The native
 *   Plan Auto classifier is switched off, so every request reaches the client.
 * - `auto`: the native `useAutoModeDuringPlan` classifier decides; the client
 *   approves nothing on its own. Other configuration (managed policy in
 *   particular) may still forbid the native classifier — we do not bypass it.
 * - `manual`: the native classifier is switched off and the client approves
 *   nothing: every request that reaches the editor shows its permission card.
 */
export type PlanPermissionPolicy = 'skip' | 'auto' | 'manual'

export const DEFAULT_PLAN_PERMISSION_POLICY: PlanPermissionPolicy = 'skip'

export const PLAN_PERMISSION_POLICIES: readonly PlanPermissionPolicy[] = ['skip', 'auto', 'manual']

export function isPlanPermissionPolicy(value: unknown): value is PlanPermissionPolicy {
  return (
    typeof value === 'string' && (PLAN_PERMISSION_POLICIES as readonly string[]).includes(value)
  )
}

export function isClaudeAgent(agentId: string): boolean {
  return agentId === CLAUDE_AGENT_ID
}

/**
 * Read the policy at the personal layer. Values in any other layer (project,
 * workspace, memory) are ignored on purpose — see {@link PLAN_PERMISSION_POLICY_KEY}.
 */
export function readPlanPermissionPolicy(config: IConfigurationService): PlanPermissionPolicy {
  const value = config.getValueForTarget<unknown>(
    PLAN_PERMISSION_POLICY_KEY,
    ConfigurationTarget.User,
  )
  return isPlanPermissionPolicy(value) ? value : DEFAULT_PLAN_PERMISSION_POLICY
}

/**
 * The `_meta.claudeCode.options` slice that pins the native Plan Auto classifier
 * for a Claude session.
 *
 * `auto` turns the CLI's own classifier on; the other two modes pass an explicit
 * `false`, which disables it even when the user's own settings.json enables it
 * (the `settings` option is the CLI's flag-settings tier, above user/project/
 * local files — managed/organization policy still outranks it and is not
 * bypassed).
 */
export function claudePlanAutoModeOptions(policy: PlanPermissionPolicy): Record<string, unknown> {
  return { settings: { useAutoModeDuringPlan: policy === 'auto' } }
}

/**
 * The claude fork's one-shot approval id. Matched exactly (not by kind):
 * codex-acp spells its equivalent `allow_once`, and a durable option must never
 * be picked in its place.
 */
const ALLOW_ONCE_OPTION_ID = 'allow-once'

/**
 * The option `skip` selects: "yes, once" — lets this one request through and
 * writes no rule. `undefined` means the agent offered no such option, in which
 * case the request must fall back to the permission card (never to a durable
 * option the user did not choose).
 *
 * `switch_mode` (ExitPlanMode) is excluded: the plan-review card keeps its
 * visible countdown (`acp.plan.autoExecute`).
 */
export function selectSkipOneShotOption(params: RequestPermissionRequest): string | undefined {
  if (params.toolCall.kind === 'switch_mode') return undefined
  return params.options.find(
    (option) => option.optionId === ALLOW_ONCE_OPTION_ID && option.kind === 'allow_once',
  )?.optionId
}
