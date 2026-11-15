/*---------------------------------------------------------------------------------------------
 *  Behaviour contract for a session started by an automated run (agent triggers
 *  today, any future automation tomorrow). ACP owns the plumbing — permission
 *  sink, plan-approval policy and completion-toast suppression — but not the
 *  policy itself: the module that starts the run supplies this profile when it
 *  creates the session. ACP never imports that module and never interprets the
 *  origin metadata; it only persists and returns it verbatim.
 *--------------------------------------------------------------------------------------------*/

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { PlanPermissionPolicy } from './planPermissionPolicy.js'

/** `info` = done, no attention needed; `escalate` = the user should look at it. */
export type AcpAutomationVerdict = 'info' | 'escalate'

export type AcpAutomationOutcome =
  | 'completed'
  | 'budget-exceeded'
  | 'timeout'
  | 'approval-timeout'
  | 'cancelled'
  | 'failed'

/** Persisted provenance shown by session lists / the phone inbox. */
export interface AcpAutomationOrigin {
  readonly triggerId: string
  readonly triggerName: string
  /** Workspace folder name; two workspaces may define the same trigger id. */
  readonly workspaceName?: string
  readonly eventKey: string
  readonly runId: string
}

/**
 * Opaque automation metadata stored on a history row. ACP only spreads and
 * returns it; the field meanings belong to the module that created the profile.
 * `runDir` scopes the one-shot run-directory write approval and is restored on
 * resume; `systemPromptAppend` is the exact static contract sent with every
 * handshake of the session (the agent fork fingerprints it).
 */
export interface AcpSessionAutomation extends AcpAutomationOrigin {
  readonly runDir?: string
  readonly systemPromptAppend?: string
  readonly verdict?: AcpAutomationVerdict
  readonly summary?: string
  readonly outcome?: AcpAutomationOutcome
}

/** The mutable half of {@link AcpSessionAutomation}, as written by the run watcher. */
export interface AcpSessionAutomationResult {
  readonly verdict?: AcpAutomationVerdict
  readonly summary?: string
  readonly outcome?: AcpAutomationOutcome
}

/**
 * Policy bundle injected by the automation module. `decidePermission` returns
 * an option id to select silently, or `undefined` to fall through to the
 * permission card. `planPolicy` pins Claude plan approvals (`manual` for
 * unattended runs). `suppressCompletionNotify` keeps the generic "agent
 * finished" toast off, because the run has its own result notification.
 */
export interface AcpAutomationProfile {
  /** Persisted/display metadata; opaque to ACP. */
  readonly origin: AcpSessionAutomation
  /** Static system-prompt append this session must carry on every handshake. */
  readonly systemPromptAppend?: string
  readonly suppressCompletionNotify: boolean
  readonly planPolicy: PlanPermissionPolicy
  decidePermission(request: RequestPermissionRequest): string | undefined
}

/**
 * Rebuilds a profile for a session resumed from history. The policy callbacks
 * cannot be serialized, so a resumed run keeps the restricted defaults (no
 * silent approvals, human-only plan cards, completion toast suppressed) and
 * reuses only the persisted origin / prompt contract.
 */
export function createRestoredAutomationProfile(
  automation: AcpSessionAutomation,
): AcpAutomationProfile {
  return {
    origin: automation,
    ...(automation.systemPromptAppend !== undefined
      ? { systemPromptAppend: automation.systemPromptAppend }
      : {}),
    suppressCompletionNotify: true,
    planPolicy: 'manual',
    decidePermission: () => undefined,
  }
}

/**
 * The options an automated session's permission card may offer. `allow_always`
 * entries are hidden: choosing one would call `persistAllow` and leak a durable
 * rule into the user's personal auto-approval memory layer.
 */
export function visibleAutomationPermissionOptions<T extends { readonly kind?: string }>(
  options: readonly T[],
): readonly T[] {
  return options.filter((option) => option.kind !== 'allow_always')
}
