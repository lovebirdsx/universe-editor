/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Plan-review auto-execute contract — the approval option each agent fork offers
 *  when a plan is ready, plus the shared "this session is planning" predicates.
 *  Pure helpers only, so the session facade and the cards cannot drift apart.
 *--------------------------------------------------------------------------------------------*/

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

/** Personal setting driving the countdown on the plan-review card. */
export const PLAN_AUTO_EXECUTE_SETTING = 'acp.plan.autoExecute'

/** The codex fork's approval option — its plan review has no permission tiers. */
export const CODEX_IMPLEMENT_PLAN_OPTION_ID = 'implement_plan'

/**
 * Setting value → the approval option ids it may pick, in priority order. The
 * clear-context variants (`exit-plan-clear-*`) and every reject option are
 * deliberately absent: auto-execute only ever keeps the context. Codex's plan
 * review has no tiers (a single `implement_plan`), so every value falls back to it.
 */
const APPROVE_OPTION_IDS: Readonly<Record<string, readonly string[]>> = {
  bypassPermissions: ['exit-plan-bypass', CODEX_IMPLEMENT_PLAN_OPTION_ID],
  auto: ['exit-plan-auto', CODEX_IMPLEMENT_PLAN_OPTION_ID],
  acceptEdits: ['exit-plan-accept-edits', CODEX_IMPLEMENT_PLAN_OPTION_ID],
  default: ['exit-plan-default', CODEX_IMPLEMENT_PLAN_OPTION_ID],
}

/** Ids {@link selectPlanAutoExecuteOptionId} accepts for this value; empty = unrecognized. */
export function planApproveOptionIds(mode: string): readonly string[] {
  return APPROVE_OPTION_IDS[mode] ?? []
}

/**
 * The option this plan review should auto-pick, or `undefined` to fall back to a
 * manual card (fail-closed).
 *
 * Detection goes by the option contract, never by agentId: an `acp.agents` entry
 * may reuse an id while launching something else, so the id does not identify a
 * fork. A candidate only wins when it is actually offered with an allowing kind —
 * a reject is never selected on the user's behalf.
 */
export function selectPlanAutoExecuteOptionId(
  options: readonly { readonly optionId: string; readonly kind?: string }[],
  mode: string,
): string | undefined {
  return planApproveOptionIds(mode).find((optionId) =>
    options.some(
      (option) =>
        option.optionId === optionId &&
        (option.kind === 'allow_once' || option.kind === 'allow_always'),
    ),
  )
}

/**
 * Whether the session is in plan mode. Claude advertises plan as a value of the
 * `mode` option; codex keeps it in a separate `collaboration_mode` option.
 */
export function isPlanModeConfigOptions(options: readonly SessionConfigOption[]): boolean {
  return options.some(
    (option) =>
      option.currentValue === 'plan' &&
      (option.category === 'mode' || option.category === 'collaboration_mode'),
  )
}

/**
 * Whether a plan-review card can carry its "keep planning" feedback back to the
 * agent (`_meta.feedback`, which the fork reads as the denied tool call's
 * message). Codex's plan review only reads optionId and silently drops it, so the
 * steering box must not be rendered there. Recognized by contract rather than by
 * "anything that is not Claude", which would hide it from third-party agents that
 * do read `_meta`.
 */
export function supportsPlanReviewFeedback(
  options: readonly { readonly optionId: string }[],
): boolean {
  return !options.some((option) => option.optionId === CODEX_IMPLEMENT_PLAN_OPTION_ID)
}
