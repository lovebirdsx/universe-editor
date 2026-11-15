/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent triggers: config shape, events, runs and verdicts shared by main and renderer.
 *  Docs: docs/development/triggers.md
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
  | { readonly type: 'event'; readonly event: TriggerEventName }

export type TriggerSourceType = TriggerSourceConfig['type']

/** Editor-pushed events (as opposed to `poll`, where the user's command fetches the data). */
export const TRIGGER_EVENT_NAMES = ['swarm.reviewNeedsAction'] as const

export type TriggerEventName = (typeof TRIGGER_EVENT_NAMES)[number]

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

export type TriggerOverflow = 'queue' | 'drop'

export interface TriggerConfig {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** Reveal the started session's chat, but only in a window the user can see. */
  readonly showSession: boolean
  readonly source: TriggerSourceConfig
  readonly session: TriggerSessionConfig
  readonly concurrency: number
  readonly overflow: TriggerOverflow
}

/**
 * Stable codes for configuration validation errors. The renderer localizes by
 * code; main / logs consume the accompanying readable `message`.
 */
export type TriggerConfigErrorCode =
  | 'document.notObject'
  | 'document.version'
  | 'document.triggersNotArray'
  | 'trigger.notObject'
  | 'trigger.id.invalid'
  | 'trigger.id.duplicate'
  | 'request.field.boolean'
  | 'request.field.nonEmptyString'
  | 'request.field.string'
  | 'request.field.integerRange'
  | 'request.field.enum'
  | 'request.field.positiveNumber'
  | 'request.field.stringArray'
  | 'source.notObject'
  | 'source.type.invalid'
  | 'source.schedule.mode'
  | 'source.cron.invalid'
  | 'source.poll.timeoutNotLessThanInterval'
  | 'session.notObject'
  | 'session.cwd.invalid'
  | 'session.skill.invalid'
  | 'session.promptOrSkill.required'
  | 'session.budget.notObject'

export type TriggerConfigErrorParams = Readonly<Record<string, string | number>>

/**
 * One validation error. `path` is relative to the trigger object (empty for a
 * whole-trigger / whole-file error), so the form can highlight the owning field
 * instead of matching English message prefixes.
 */
export interface TriggerConfigError {
  readonly path: readonly (string | number)[]
  readonly code: TriggerConfigErrorCode
  readonly params: TriggerConfigErrorParams
  /** Readable message for non-localizing consumers (main logs, QuickPick). */
  readonly message: string
}

/** A trigger entry that failed validation; listed with its errors, never run. */
export interface InvalidTriggerConfig {
  readonly id: string
  /**
   * Readable messages, kept as the compatibility surface for existing main-side
   * consumers (`TriggerSummary.errors`, error logs). The localized manager uses
   * {@link issues}.
   */
  readonly errors: readonly string[]
  /** Structured errors carrying path / code / params. */
  readonly issues: readonly TriggerConfigError[]
}

/** One workspace's `.universe-editor/triggers.json`; trigger ids are unique inside it only. */
export interface TriggersConfig {
  readonly version: 1
  readonly triggers: readonly TriggerConfig[]
  readonly invalid: readonly InvalidTriggerConfig[]
}

/** Workspace-relative location of a commit-able trigger definition file. */
export const TRIGGERS_WORKSPACE_DIR = '.universe-editor'
export const TRIGGERS_WORKSPACE_CONFIG_FILE = 'triggers.json'

/** Machine-local registry entry (`<userData>/triggers/workspaces.json`). */
export interface TriggerWorkspaceSummary {
  /** Workspace URI string (`file:///…` / `remote-ssh://…`). */
  readonly workspace: string
  /** Folder name, shown instead of the raw URI. */
  readonly name: string
  /** Path of the workspace trigger file on the host that owns the folder. */
  readonly configPath: string
  /** False when the folder or its triggers.json disappeared after registration. */
  readonly available: boolean
  readonly triggerCount: number
}

/** User setting for the machine-wide concurrent run cap (not per workspace). */
export const TRIGGERS_MAX_CONCURRENT_RUNS_KEY = 'triggers.maxConcurrentRuns'

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

/** `info` = done, no attention needed; `escalate` = the user should look at it. */
export type TriggerVerdictKind = 'info' | 'escalate'

/** Parsed `<runDir>/result.json`. */
export interface TriggerVerdict {
  readonly verdict: TriggerVerdictKind
  readonly summary: string
  readonly reportPath?: string
}

/** Provenance stamped on an automated session (persisted in session history). */
export interface AutomationOrigin {
  readonly triggerId: string
  readonly triggerName: string
  /** Workspace folder name; two workspaces may define the same trigger id. */
  readonly workspaceName?: string
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
  /**
   * Reveal the started session's chat in this window. Only honored when the
   * window is visible; hidden / minimized windows are never raised.
   */
  readonly showSession: boolean
  /** Absolute host-native path (local machine for local workspaces, remote host for remote ones). */
  readonly cwd: string
  /**
   * Remote workspace authority (`remote-ssh`); undefined for a local workspace.
   * `cwd` / `runDir` are then paths on that remote host.
   */
  readonly authority?: string
  /** Explicit mode id; undefined = the agent's conservative default (resolved in renderer). */
  readonly mode?: string
  /** True only when the activation confirmation covers the current (bypass-class) mode. */
  readonly allowElevatedMode: boolean
  readonly model?: string
  readonly mcpServerNames?: readonly string[]
  /** Fully rendered prompt with the output contract inline (skill prefix + data fence + result contract). */
  readonly prompt: string
  /**
   * Same prompt rendered for agents that receive the output contract through
   * their system prompt: no `## 输出要求` section, only the run directory.
   */
  readonly promptForSystemContract: string
  /**
   * Absolute host-native `<runs dir>/<runId>`; already created by main. On the
   * remote host when `authority` is set.
   */
  readonly runDir: string
  readonly budget: TriggerBudget
}

/** renderer → main when a run reaches a terminal state. */
export interface TriggerRunEnd {
  readonly runId: string
  readonly triggerId: string
  readonly sessionId?: string
  readonly outcome: TriggerRunOutcome
  /** A missing or unparseable result.json yields `escalate`. */
  readonly verdict?: TriggerVerdictKind
  readonly summary?: string
  readonly error?: string
  /** Active session time in milliseconds (time parked on a card is excluded). */
  readonly durationMs?: number
  /** Session cost when the agent reported it in USD (other currencies are dropped). */
  readonly costUsd?: number
}

/** One row of the machine-local `<userData>/triggers/history.jsonl`. */
export interface TriggerRunHistoryEntry {
  readonly runId: string
  /** Composite workspace + id; the same trigger id can exist in several workspaces. */
  readonly triggerKey: string
  readonly triggerId: string
  readonly triggerName: string
  /** Workspace URI string (`file:///…` / `remote-ssh://…`). */
  readonly workspace: string
  readonly workspaceName: string
  readonly sessionId?: string
  readonly startedAt: number
  readonly endedAt: number
  readonly outcome: TriggerRunOutcome
  readonly verdict?: TriggerVerdictKind
  readonly summary?: string
  readonly error?: string
  readonly costUsd?: number
  readonly durationMs?: number
}

/** Query for the run history; `limit` defaults to 100 and is capped at 500. */
export interface TriggerRunFilter {
  readonly limit?: number
  readonly triggerKey?: string
  readonly workspace?: string
  readonly outcome?: TriggerRunOutcome
}

/**
 * Renderer-facing read of one run's `report.md`. The renderer supplies only a
 * run id; main rebuilds and validates the path on disk.
 */
export type TriggerRunReportReadResult =
  | {
      readonly kind: 'ok'
      readonly text: string
      /** Run directory URI string (file: or remote-ssh:), the Markdown base for relative resources. */
      readonly runDir: string
      /** Report file mtime (Unix ms). */
      readonly modifiedAt: number
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'too-large' }
  /** The run lives on a remote host that is not connected right now. */
  | { readonly kind: 'unavailable' }

/** Upper bound for `report.md` on both the phone gateway and the desktop reader. */
export const MAX_TRIGGER_REPORT_BYTES = 512 * 1024

export type TriggerStatus =
  | 'disabled'
  | 'idle'
  | 'running'
  | 'paused'
  | 'invalid'
  | 'needs-confirmation'

export interface TriggerSessionSurface {
  readonly agent?: string
  readonly mode?: string
  readonly skill?: string
  readonly mcpServers?: readonly string[]
}

export interface TriggerSummary {
  /** Composite identity (workspace + id); every command takes this, never the bare id. */
  readonly key: string
  readonly id: string
  readonly name: string
  /**
   * Fingerprint of the definition the summary was built from. `confirmActivation`
   * binds the grant to it, so a definition edited while the dialog is open cannot
   * be confirmed unseen. Empty for invalid entries (they cannot be confirmed).
   */
  readonly fingerprint: string
  /** Workspace URI string (`file:///…` / `remote-ssh://…`) that owns this trigger. */
  readonly workspace: string
  /** Folder name, shown next to the trigger name to disambiguate equal ids. */
  readonly workspaceName: string
  readonly sourceType: TriggerSourceType | 'unknown'
  readonly status: TriggerStatus
  /**
   * The owning remote workspace is disconnected. The definition stays listed from
   * the last snapshot but nothing is scheduled until the connection returns.
   */
  readonly offline?: boolean
  readonly enabled: boolean
  readonly paused: boolean
  /** Machine-wide pause (`pausedAll`); every trigger row is paused regardless of `paused`. */
  readonly pausedAll: boolean
  /** Paused automatically after repeated failures (persisted, not derived). */
  readonly autoPaused: boolean
  /** The parsed source config, for presentation (next-run / source wording). */
  readonly source?: TriggerSourceConfig
  /**
   * The user confirmed this workspace-defined trigger (bound to the config
   * fingerprint). The only local gate; it also covers a bypass-class mode.
   */
  readonly activationConfirmed: boolean
  /** Configured mode is bypass-class (shown with a warning marker). */
  readonly elevatedMode: boolean
  /** Session settings listed in the activation confirmation dialog. */
  readonly session?: TriggerSessionSurface
  readonly running: number
  readonly queued: number
  readonly consecutiveFailures: number
  readonly lastRunAt?: number
  readonly nextRunAt?: number
  readonly lastError?: string
  readonly errors?: readonly string[]
  /** Structured counterpart of {@link errors} (path / code / params), for the manager UI. */
  readonly issues?: readonly TriggerConfigError[]
  /** Synopsis of the most recent run (persisted in `state.json`, survives restarts). */
  readonly lastRunId?: string
  readonly lastSessionId?: string
  readonly lastRunOutcome?: TriggerRunOutcome
  readonly lastRunVerdict?: TriggerVerdictKind
  /** Truncated to 200 characters. */
  readonly lastRunSummary?: string
  readonly lastRunCostUsd?: number
  readonly lastRunDurationMs?: number
}

/**
 * Mode ids that let an agent act without a human approving each step, for every
 * agent (claude + codex forks). Not only bypass: claude `auto` / `acceptEdits` and
 * codex `agent` (auto-review) also skip the approval card, so the activation
 * confirmation calls them out.
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
