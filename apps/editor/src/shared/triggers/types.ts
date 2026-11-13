/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent triggers: config shape, events, runs and verdicts shared by main and renderer.
 *  Design: docs/development/triggers-design.md
 *--------------------------------------------------------------------------------------------*/

export type TriggerOnMissed = 'skip' | 'catch-up-once'

export type TriggerSourceConfig =
  | { readonly type: 'manual' }
  | {
      readonly type: 'schedule'
      /** 5-field cron (`min hour dom month dow`); exactly one of cron / everyMin. */
      readonly cron?: string
      readonly everyMin?: number
      readonly onMissed: TriggerOnMissed
    }
  | {
      readonly type: 'poll'
      readonly intervalSec: number
      readonly fetch: {
        readonly type: 'command'
        readonly command: string
        readonly timeoutSec: number
      }
      readonly keyField: string
    }
  | { readonly type: 'swarm-review' }

export type TriggerSourceType = TriggerSourceConfig['type']

export interface TriggerBudget {
  /** `null` = no cost ceiling (explicit opt-out; an omitted field still gets the default). */
  readonly maxCostUsd: number | null
  /** Active session time; time spent waiting on a permission / question card is excluded. */
  readonly timeoutMin: number
  readonly approvalTimeoutMin: number
}

export interface TriggerSessionConfig {
  readonly agent?: string
  /** Relative to the trigger's workspace; must stay inside it. */
  readonly cwd?: string
  readonly mode?: string
  readonly model?: string
  readonly skill?: string
  readonly prompt: string
  readonly mcpServers?: readonly string[]
  readonly budget: TriggerBudget
}

export type TriggerActionType = 'swarm.vote' | 'swarm.comment' | 'swarm.approve'

export const TRIGGER_ACTION_TYPES: readonly TriggerActionType[] = [
  'swarm.vote',
  'swarm.comment',
  'swarm.approve',
]

export type TriggerOverflow = 'queue' | 'drop'

export interface TriggerConfig {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** Local folder path (no remote authority). */
  readonly workspace: string
  readonly source: TriggerSourceConfig
  readonly session: TriggerSessionConfig
  readonly allowedActions: readonly TriggerActionType[]
  readonly concurrency: number
  readonly overflow: TriggerOverflow
}

/** A trigger entry that failed validation; listed with its errors, never run. */
export interface InvalidTriggerConfig {
  readonly id: string
  readonly errors: readonly string[]
}

export interface TriggersConfig {
  readonly version: 1
  readonly maxConcurrentRuns: number
  readonly triggers: readonly TriggerConfig[]
  readonly invalid: readonly InvalidTriggerConfig[]
}

export const TRIGGER_DEFAULTS = {
  maxConcurrentRuns: 2,
  concurrency: 1,
  overflow: 'queue' as TriggerOverflow,
  queueLimit: 20,
  budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 } satisfies TriggerBudget,
  pollTimeoutSec: 60,
  failurePauseThreshold: 5,
  startupGraceMs: 60_000,
  /** Renderer `startRun` RPC has no transport timeout; a wedged window must not hold a slot forever. */
  startRunTimeoutMs: 120_000,
  processedKeyLimit: 2000,
  processedKeyTtlMs: 30 * 24 * 60 * 60 * 1000,
} as const

export type TriggerPayloadValue = string | number | boolean

export interface TriggerEvent {
  readonly triggerId: string
  readonly key: string
  readonly payload: Readonly<Record<string, TriggerPayloadValue>>
  readonly firedAt: number
}

export type TriggerVerdictKind = 'auto-approve' | 'escalate' | 'reject' | 'info'

export interface TriggerVerdictAction {
  readonly type: string
  readonly target: string
  readonly detail?: string
}

/** Parsed `<runDir>/result.json`. */
export interface TriggerVerdict {
  readonly verdict: TriggerVerdictKind
  readonly summary: string
  readonly reportPath?: string
  readonly actions: readonly TriggerVerdictAction[]
}

/** Provenance stamped on an automated session (persisted in session history). */
export interface AutomationOrigin {
  readonly triggerId: string
  readonly triggerName: string
  readonly eventKey: string
  readonly runId: string
}

export type TriggerRunOutcome =
  | 'completed'
  | 'budget-exceeded'
  | 'timeout'
  | 'approval-timeout'
  | 'cancelled'
  | 'failed'

/** main → renderer: everything the window needs to start one automated run. */
export interface TriggerRunRequest {
  readonly origin: AutomationOrigin
  readonly agentId?: string
  /** Absolute local path. */
  readonly cwd: string
  /** Explicit mode id; undefined = the agent's conservative default (resolved in renderer). */
  readonly mode?: string
  /** True only after the user confirmed a bypass-class mode for this trigger. */
  readonly allowElevatedMode: boolean
  readonly model?: string
  readonly mcpServerNames?: readonly string[]
  /** Fully rendered prompt (skill prefix + data fence + result contract). */
  readonly prompt: string
  /** Absolute `<userData>/triggers/runs/<runId>`; already created by main. */
  readonly runDir: string
  readonly budget: TriggerBudget
  readonly allowedActions: readonly TriggerActionType[]
  /** True only after the user confirmed automatic swarm approve for this trigger. */
  readonly approveConfirmed: boolean
  /** Event payload (needed by action guards, e.g. reviewId / version); never logged. */
  readonly payload: Readonly<Record<string, TriggerPayloadValue>>
  /** Swarm actions are only honored for `swarm-review` runs, whose target is the event's review. */
  readonly sourceType: TriggerSourceType
}

export interface TriggerActionAudit {
  readonly type: string
  readonly target: string
  readonly result: 'ok' | 'rejected' | 'failed'
  readonly reason?: string
}

/** renderer → main when a run reaches a terminal state. */
export interface TriggerRunEnd {
  readonly runId: string
  readonly triggerId: string
  readonly sessionId?: string
  readonly outcome: TriggerRunOutcome
  /** After action validation (an out-of-whitelist action downgrades to escalate). */
  readonly verdict?: TriggerVerdictKind
  readonly summary?: string
  readonly actions: readonly TriggerActionAudit[]
  readonly error?: string
}

/**
 * Renderer-facing read of one run's `report.md`. The renderer supplies only a
 * run id; main rebuilds and validates the path on disk.
 */
export type TriggerRunReportReadResult =
  | {
      readonly kind: 'ok'
      readonly text: string
      /** Resolved run directory, used as the Markdown base for relative resources. */
      readonly runDir: string
      /** Report file mtime (Unix ms). */
      readonly modifiedAt: number
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'too-large' }

/** Upper bound for `report.md` on both the phone gateway and the desktop reader. */
export const MAX_TRIGGER_REPORT_BYTES = 512 * 1024

export type TriggerStatus =
  | 'disabled'
  | 'idle'
  | 'running'
  | 'paused'
  | 'invalid'
  | 'needs-confirmation'

export interface TriggerSummary {
  readonly id: string
  readonly name: string
  readonly sourceType: TriggerSourceType | 'unknown'
  readonly status: TriggerStatus
  readonly enabled: boolean
  readonly paused: boolean
  /** Configured mode is bypass-class (shown with a warning marker). */
  readonly elevatedMode: boolean
  readonly elevatedModeConfirmed: boolean
  readonly approveAction: boolean
  readonly approveConfirmed: boolean
  readonly running: number
  readonly queued: number
  readonly consecutiveFailures: number
  readonly lastRunAt?: number
  readonly nextRunAt?: number
  readonly lastError?: string
  readonly errors?: readonly string[]
}

/**
 * Mode ids that let an agent act without a human approving each step, for every
 * agent (claude + codex forks). Not only bypass: claude `auto` / `acceptEdits` and
 * codex `agent` (auto-review) also skip the approval card, so all of them need the
 * per-trigger confirmation.
 */
export const ELEVATED_MODE_IDS: readonly string[] = [
  'bypassPermissions',
  'auto',
  'acceptEdits',
  'agent',
  'full-access',
  'agent-full-access',
  'danger-full-access',
]

/** Case-insensitive, so a mistyped `BypassPermissions` cannot dodge the confirmation. */
export function isElevatedModeId(mode: string | undefined): boolean {
  if (mode === undefined) return false
  const normalized = mode.trim().toLowerCase()
  return ELEVATED_MODE_IDS.some((id) => id.toLowerCase() === normalized)
}

/** Conservative default mode per agent when a trigger leaves `session.mode` unset. */
export const CONSERVATIVE_MODE_BY_AGENT: Readonly<Record<string, string>> = {
  'claude-code': 'default',
  codex: 'read-only',
}
