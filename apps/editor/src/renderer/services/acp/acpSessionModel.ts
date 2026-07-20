/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSession view-model types — the public shapes the React layer and other ACP
 *  services consume (messages, tool calls, plan, timeline, usage, permissions,
 *  questions) plus the IAcpSession contract. Split out of acpSession.ts so the
 *  type surface is browsable apart from the 1.8k-line session implementation;
 *  acpSession.ts re-exports all of these so existing import paths keep working.
 *--------------------------------------------------------------------------------------------*/

import type { AvailableCommand, ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Event, IObservable } from '@universe-editor/platform'
import type { McpTransport } from './acpMcpServers.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import type { SelectionContext } from './promptContext.js'
import type { PromptImage } from './promptImage.js'
import type { PlacedRef } from './promptRef.js'

export type AcpMessageRole = 'user' | 'agent' | 'thought'

export interface AcpMessage {
  readonly id: string
  readonly role: AcpMessageRole
  /** Plain-text view of `blocks`, computed via {@link blocksToText}. */
  readonly text: string
  /** Structured content blocks — used by the renderer for markdown / images / resource links. */
  readonly blocks: readonly ContentBlock[]
  /** True while this message is still receiving streaming chunks; the UI uses this to render a blinking caret. */
  readonly streaming: boolean
  /**
   * Agent-side stable id for this message (a client-generated uuid sent as
   * `PromptRequest.messageId` and echoed back as `PromptResponse.userMessageId`).
   * Only user messages carry it; it is the anchor rewind/fork use to locate the
   * turn on the agent. `undefined` for agent/thought messages and for user
   * messages sent before this field existed.
   */
  readonly messageId?: string
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface AcpToolCallDiff {
  readonly path: string
  /** Empty string when the agent reported `null` (i.e. file creation). */
  readonly oldText: string
  readonly newText: string
}

export interface AcpToolCall {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: AcpToolCallStatus
  /**
   * Raw tool input parameters as reported by the agent (`ToolCall.rawInput`).
   * Kept so the UI can surface a friendly title (e.g. a Bash tool's
   * `description`) and demote the raw command line to a secondary detail.
   * `unknown` because the shape varies per tool; consumers narrow defensively.
   */
  readonly rawInput?: unknown
  /** Plain-text view of `blocks`. */
  readonly text: string
  /**
   * Tool call output normalized into ContentBlock[]. ToolCallContent variants
   * `content` are unwrapped; `terminal` is converted to a placeholder text block.
   * `diff` entries are *not* included here — they live in `diffs` so the UI can
   * render a dedicated diff preview.
   */
  readonly blocks: readonly ContentBlock[]
  /** Structured diff entries extracted from ToolCallContent.diff. */
  readonly diffs: readonly AcpToolCallDiff[]
  /**
   * Sub-agent timeline: message / tool_call updates the agent tagged with this
   * call's id via `_meta.claudeCode.parentToolUseId` (e.g. a Task tool spawning
   * a subagent). Nested one level deep — the UI folds these inside the parent
   * card so the subagent's chatter stays out of the main timeline.
   */
  readonly children?: readonly AcpChildItem[]
  /**
   * Source MCP server name when this tool call is an MCP tool. Derived from the
   * agent fork's `_meta.claudeCode.toolName` (`mcp__<server>__<tool>`). Absent
   * for built-in tools. Drives the "MCP · <server>" attribution badge.
   */
  readonly mcpServer?: string
  /**
   * Source MCP tool segment (`<tool>` in `mcp__<server>__<tool>`). Kept so the
   * UI can humanize it into a friendly card title (e.g. `ue_create_session` →
   * `Create Session`). Absent for built-in tools.
   */
  readonly mcpTool?: string
}

/**
 * One slot inside a parent tool call's {@link AcpToolCall.children}. Structurally
 * identical to {@link TimelineItem} but named separately to make the nesting
 * explicit. Only one level of nesting is supported — a child tool call's own
 * `children` is never populated.
 */
export type AcpChildItem =
  | { readonly kind: 'message'; readonly id: string; readonly message: AcpMessage }
  | { readonly kind: 'toolCall'; readonly id: string; readonly call: AcpToolCall }

export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed'

export interface AcpPlanEntry {
  readonly content: string
  readonly status: AcpPlanEntryStatus
  readonly priority?: string
}

/**
 * Observable view of one configured/connected MCP server. `status` is the raw
 * string from the Claude SDK system-init snapshot (e.g. `connected` / `failed`
 * / `needs-auth` / `pending`). `transport` is seeded from the `acp.mcpServers`
 * config; servers that only appear in the init snapshot (agent-provided) have
 * no known transport.
 */
export interface AcpMcpServerStatus {
  readonly name: string
  readonly status: string
  readonly transport?: McpTransport
}

/**
 * A single slot on the unified chat timeline. The UI renders one ordered list
 * of these so message / tool_call cards interleave by arrival order, matching
 * Copilot-style agent chat layout. Plan is *not* a timeline slot — it lives on
 * the dedicated `plan` observable and is rendered as a sticky bar above the
 * scroll, so it stays pinned instead of being pushed out of view by later items.
 *
 * Slot identity rules:
 * - `kind: 'message'` reuses the underlying `message.id` so React keys are
 *   stable across chunk merges.
 * - `kind: 'toolCall'` reuses the agent-issued `toolCallId` so `tool_call_update`
 *   replaces the existing slot in place.
 */
export type TimelineItem =
  | { readonly kind: 'message'; readonly id: string; readonly message: AcpMessage }
  | { readonly kind: 'toolCall'; readonly id: string; readonly call: AcpToolCall }
  | { readonly kind: 'compaction'; readonly id: string; readonly compaction: AcpCompaction }

/** Lifecycle phase of a context-compaction event surfaced on the timeline. */
export type AcpCompactionPhase = 'running' | 'success' | 'failed'

/**
 * A context-compaction marker on the timeline. The agent summarizes older
 * conversation to free context space; this slot renders a dedicated status card
 * (spinner while `running`, a settled marker on `success`/`failed`) instead of
 * leaking plain-text "Compacting…" chunks into the assistant message stream.
 * The `running` slot is replaced in place with its outcome via the stable `id`.
 */
export interface AcpCompaction {
  readonly phase: AcpCompactionPhase
  /** Failure detail on `phase: 'failed'`, if the agent reported one. */
  readonly reason?: string
  /**
   * Wall-clock start (ms, `Date.now()`) stamped when `running` begins. The SDK
   * compaction is an atomic summarization call with no real progress signal, so
   * the card renders a live stopwatch from this — mirroring the CLI's elapsed
   * timer — to reassure the user something is happening.
   */
  readonly startedAt?: number
  /** Elapsed ms at settle, computed on `success`/`failed` from `startedAt`. */
  readonly durationMs?: number
  /**
   * Expected total duration (ms) for this compaction, seeded when `running`
   * begins from the median of past successful compactions for the same agent
   * (see {@link IAcpCompactionStatsService}). The card drives its progress
   * estimate off this so the bar reaches ~90% around the historically typical
   * finish time instead of a fixed constant. Absent until enough samples exist.
   */
  readonly expectedDurationMs?: number
}

export interface AcpPendingPermission {
  readonly toolCallId: string
  readonly title: string
  readonly kind?: string
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind?: string
  }[]
  /**
   * 用户选择某个选项。`feedback` 仅对 ExitPlanMode 的 reject（"继续规划"）有意义：
   * 用户在 steering 输入框写下的意见，会作为被拒工具的 deny message 回传给 agent，
   * 从而落盘为可回放的 tool_result（而非丢失的 queued_command）。
   */
  resolve(optionId: string, feedback?: string): void
  cancel(): void
}

/**
 * ACP extension method carrying the `AskUserQuestion` round-trip. The built-in
 * agent (vendor/claude-agent-acp) sends questions over this method and expects
 * the user's answers back. The string is shared verbatim with the agent fork's
 * `interactive.ts` — keep both in sync.
 */
export const ASK_USER_QUESTION_METHOD = 'universe-editor/ask_user_question'

/**
 * Custom ACP request that persists an AI-generated session title onto the
 * agent's durable store (the fork backs it with `renameSession`). Shared
 * verbatim with the agent fork's `acp-agent.ts` (`SET_SESSION_TITLE_METHOD`) —
 * keep both in sync. Without this round-trip the title lives only client-side
 * and `session/list`'s `summary` clobbers it after `/compact`.
 */
export const SET_SESSION_TITLE_METHOD = 'universe-editor/set_session_title'

/**
 * Custom ACP request that rewinds a session to a specific user message (回退):
 * restores files edited since that message to their on-disk state at that point,
 * and truncates the conversation history past it. Shared verbatim with the agent
 * fork's `acp-agent.ts` (`REWIND_SESSION_METHOD`) — keep both in sync. Params:
 * `{ sessionId, messageId, dryRun? }` where `messageId` is the id the client
 * stamped on the user turn (see {@link AcpMessage.messageId}); the response is a
 * {@link RewindFilesResult}.
 */
export const REWIND_SESSION_METHOD = 'universe-editor/rewind_session'

/**
 * Custom ACP extension notification the agent fork sends to surface
 * context-compaction lifecycle (`start` / `success` / `failed`) so the editor
 * renders a dedicated timeline card instead of parsing plain-text chunks out of
 * the assistant message stream. Shared verbatim with the agent fork's
 * `acp-agent.ts` (`COMPACTION_METHOD`) — keep both in sync. Params:
 * `{ sessionId, id, phase, reason? }` where `id` is stable across a single
 * compaction so the in-progress card is replaced in place with its outcome.
 */
export const COMPACTION_METHOD = '_universe/compaction'

/** Result the agent returns from {@link REWIND_SESSION_METHOD} (mirrors the SDK's RewindFilesResult). */
export interface RewindFilesResult {
  readonly canRewind: boolean
  readonly error?: string
  readonly filesChanged?: readonly string[]
  readonly insertions?: number
  readonly deletions?: number
}

/** One selectable option of an {@link AskUserQuestion}. */
export interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
  /** Rich preview shown side-by-side when this option is focused. */
  readonly preview?: string
}

/** A single question in an `AskUserQuestion` tool call. */
export interface AskUserQuestion {
  readonly question: string
  readonly header: string
  readonly options: readonly AskUserQuestionOption[]
  readonly multiSelect?: boolean
}

/** Params the agent sends over {@link ASK_USER_QUESTION_METHOD}. */
export interface AskUserQuestionRequest {
  readonly sessionId: string
  readonly toolCallId: string
  readonly questions: readonly AskUserQuestion[]
}

/**
 * Response the client returns to the agent. `answers` is keyed by question
 * text with comma-joined selected labels (matching the SDK's AskUserQuestion
 * output contract); `cancelled` short-circuits to a tool denial.
 */
export interface AskUserQuestionResult {
  readonly cancelled?: boolean
  readonly answers?: Record<string, string>
  readonly annotations?: Record<string, { preview?: string; notes?: string }>
}

/** A pending question carousel awaiting the user's answers. */
export interface AcpPendingQuestion {
  readonly toolCallId: string
  readonly questions: readonly AskUserQuestion[]
  resolve(result: AskUserQuestionResult): void
  cancel(): void
}

export type AcpSessionStatus = 'idle' | 'connecting' | 'running' | 'errored' | 'closed'

/** Per-model cost/token breakdown for a session, reported by the agent. */
export interface AcpModelCost {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreateTokens: number
  /** Session-cumulative cost in USD for this model, as reported by the agent. */
  readonly costUSD: number
}

/** Context-window usage reported by the agent via `usage_update`. */
export interface AcpUsage {
  /** Tokens currently in context. */
  readonly used: number
  /** Total context window size in tokens. */
  readonly size: number
  /** Cumulative session cost, if the agent reports it. */
  readonly cost?: { readonly amount: number; readonly currency: string }
  /**
   * Per-model cost breakdown for the whole session (including sub-agent / Task
   * work), if the agent reports it. Drives the session cost popover.
   */
  readonly models?: readonly AcpModelCost[]
  /**
   * True when `cost`/`models` are locally estimated from token counts rather than
   * reported authoritatively by the agent. Codex sets this (it never reports a
   * real cost); Claude leaves it unset. The UI labels estimated costs as such.
   */
  readonly costEstimated?: boolean
}

/** Bag of normalized initial session state captured from `session/new`. */
export interface IAcpSessionInitState {
  readonly configOptions?: readonly SessionConfigOption[]
  /** Usage snapshot to seed the arc on resume (restored from history). */
  readonly usage?: AcpUsage
  /**
   * MCP servers forwarded on session/new, seeded into `mcpServers` with a
   * `pending` status before the SDK init snapshot arrives. Carries the known
   * transport from config.
   */
  readonly mcpServers?: ReadonlyArray<{ readonly name: string; readonly transport: McpTransport }>
  /** Cumulative running duration in ms, restored from history on resume. */
  readonly accumulatedRunningMs?: number
}

export interface IAcpSession {
  /**
   * The session's stable local id, generated up-front (a uuid for freshly
   * created sessions; the agent-issued id for resumed ones). It never changes
   * for the lifetime of the session, so it is safe to use as a React key /
   * runtime cache key even before the agent connection is established.
   *
   * For the durable, agent-issued protocol id (needed for `session/load`,
   * history, change-tracking, persistence) read {@link sessionIdOnAgent} — it
   * is `undefined` until the connection is attached.
   */
  readonly id: string
  readonly agentId: string
  /**
   * True for a read-only preview session: spawned to replay (`session/load`) a
   * session that belongs to a different worktree so its history can be viewed in
   * this window, without allowing any prompt / config mutation (those would have
   * side effects against the other worktree). `sendPrompt` / `setConfigOption`
   * are no-ops when set, and the chat UI hides the prompt input.
   */
  readonly readOnly: boolean
  /**
   * The agent-issued `sessionId` from `session/new` (a.k.a. `sessionIdOnAgent`).
   * `undefined` while the session is still connecting; set once
   * `attachConnection` runs. Durable across editor restarts and the key every
   * other ACP service (history, change tracker, persistence) talks in.
   */
  readonly sessionIdOnAgent: IObservable<string | undefined>
  readonly title: string
  readonly messages: IObservable<readonly AcpMessage[]>
  readonly toolCalls: IObservable<readonly AcpToolCall[]>
  readonly plan: IObservable<readonly AcpPlanEntry[]>
  /**
   * Unified chronological view: message / tool_call / plan slots ordered by
   * insertion. The canonical observable consumed by the chat UI; the three
   * lane-specific observables above remain for back-compat and selector reads.
   */
  readonly timeline: IObservable<readonly TimelineItem[]>
  readonly status: IObservable<AcpSessionStatus>
  /**
   * True while a resumed session is replaying its history via `session/load`.
   * The session is registered (so `session/update` replay routes to it) before
   * the replay finishes, leaving the timeline transiently empty; the chat UI
   * reads this to keep showing a loading placeholder instead of flashing the
   * "empty session" hint. Always false for freshly-created sessions — their
   * empty timeline is the intended end state, not a transient one.
   */
  readonly isReplayingHistory: IObservable<boolean>
  /** Latest context-window usage reported by the agent, or undefined if never reported. */
  readonly usage: IObservable<AcpUsage | undefined>
  readonly pendingPermission: IObservable<AcpPendingPermission | undefined>
  /** Active `AskUserQuestion` carousel awaiting the user's answers, if any. */
  readonly pendingQuestion: IObservable<AcpPendingQuestion | undefined>
  /** Configuration options the agent has advertised for this session. */
  readonly configOptions: IObservable<readonly SessionConfigOption[]>
  /** Latest agent-advertised slash commands (may be empty). */
  readonly availableCommands: IObservable<readonly AvailableCommand[]>
  /**
   * Configured + connected MCP servers with their latest connection status.
   * Seeded from config on session/new, then refreshed from the Claude SDK
   * system-init snapshot. Empty when no MCP servers are involved.
   */
  readonly mcpServers: IObservable<readonly AcpMcpServerStatus[]>
  /** Current timeline collapse mode for this session. */
  readonly collapseMode: IObservable<CollapseMode>
  /** Cumulative milliseconds in 'running' status — does not include the current segment if still running. */
  readonly accumulatedRunningMs: IObservable<number>
  /** Timestamp (epoch ms) when the current running segment started, or undefined if not running. */
  readonly runningStartedAt: IObservable<number | undefined>
  /**
   * Whether the connected agent advertised `promptCapabilities.image`. The
   * prompt input gates its paste/drop/pick entry points on this. Arrives async
   * after the connection attaches; `false` until known.
   */
  readonly imageSupported: IObservable<boolean>
  /**
   * Whether the connected agent advertised `sessionCapabilities.fork` (the
   * UNSTABLE `session/fork`). Gates the fork (分叉) affordance. Arrives async
   * after the connection attaches; `false` until known.
   */
  readonly forkSupported: IObservable<boolean>
  /**
   * Whether this session supports rewind (回退). First release covers
   * `claude-code` only (the file-checkpointing + `resumeSessionAt` machinery the
   * `universe-editor/rewind_session` ext-method relies on); other agents degrade
   * gracefully (the UI hides the affordance). Static per session.
   */
  readonly rewindSupported: boolean
  /**
   * Fires when a prompt (or other agent call) fails because the agent has no
   * usable credentials. The session itself has no access to the notification /
   * command services, so AcpSessionService owns the user-facing guidance.
   */
  readonly onDidRequireAuth: Event<void>
  /**
   * Resolves once the connecting phase settles — i.e. {@link attachConnection}
   * or {@link failConnection} has run. Lets callers that genuinely need the live
   * agent connection (and tests injecting agent traffic) await the background
   * handshake without blocking the initial render. Resolves immediately if the
   * session is already settled.
   */
  whenConnected(): Promise<void>
  /**
   * Mark the start of a `session/load` history replay (resume path). Flips
   * {@link isReplayingHistory} on so the chat UI shows a loading placeholder
   * rather than the empty-session hint while the timeline is still empty.
   */
  beginHistoryReplay(): void
  /** Mark the replay finished — see {@link beginHistoryReplay}. */
  endHistoryReplay(): void
  /** Cycle the timeline collapse mode: default → collapsed → expanded → default. */
  cycleCollapseMode(): void
  /** Internal — call site is the permission handler. */
  presentPermission(p: AcpPendingPermission): void
  /** Internal — call site is the AskUserQuestion sink. */
  presentQuestion(q: AcpPendingQuestion): void
  /**
   * Send a prompt. `refs` are the range-tracked `@`/`#` references embedded in
   * `text` (from the prompt editor's PromptRefTracker); each is serialized to its
   * wire ContentBlock by slicing the text at its tracked range — no re-tokenizing,
   * so labels with spaces round-trip. See composePromptBlocksFromRefs.
   *
   * `contexts` are editor selections the user explicitly attached; each leads
   * the prompt as a context block (an EmbeddedResource when the agent supports
   * `embeddedContext`, else a fenced-code text block).
   *
   * `images` are pictures the user pasted / dropped / picked; each becomes an
   * `image` ContentBlock leading the prompt. Only sent when the agent advertised
   * `promptCapabilities.image` (the input gates on it), but the session accepts
   * them unconditionally — the gate lives in the UI.
   */
  sendPrompt(
    text: string,
    refs?: readonly PlacedRef[],
    contexts?: readonly SelectionContext[],
    images?: readonly PromptImage[],
  ): Promise<void>
  cancelTurn(): Promise<void>
  close(): Promise<void>
  /** Change one configuration option via `session/set_config_option`. */
  setConfigOption(configId: string, value: string): Promise<void>
  /**
   * Manually rename the session. Ranks above the auto-generated (first-prompt /
   * AI) title: it is persisted with a `manualTitle` flag that protects it from
   * hydrate overwrites and stops any AI title regeneration, and is pushed to the
   * agent so it survives `/compact`. No-op for read-only previews / blank input.
   */
  renameTitle(title: string): void
  /**
   * Rewind the session to an earlier user message (回退). Rolls back files the
   * agent edited since that message to their on-disk state at that point AND
   * truncates the conversation past it, so the user can edit-and-retry from a
   * clean slate. Backed by the agent's `universe-editor/rewind_session`
   * ext-method (Claude only for now); the agent replays the truncated history,
   * so the local timeline is cleared and repopulated as the replay arrives.
   *
   * `dryRun` previews the file impact ({@link RewindFilesResult.filesChanged} /
   * insertions / deletions) without mutating disk or the conversation — used to
   * confirm the destructive action before committing. `rewindFiles` (default
   * true) controls whether the agent-edited files are rolled back: pass `false`
   * to truncate the conversation while keeping the working-tree edits (保留修改
   * 并回退). Returns the agent's {@link RewindFilesResult}, or `undefined` when
   * there's no live connection / agent-side session id. No-op for read-only
   * previews.
   */
  rewindTo(
    messageId: string,
    options?: { dryRun?: boolean; rewindFiles?: boolean },
  ): Promise<RewindFilesResult | undefined>
}

/**
 * Re-exported from ./acpErrors.js (the consolidated ACP error family) so the
 * historical `acpSessionModel` / `acpSession` import paths keep working.
 */
export { AcpAbortError } from './acpErrors.js'
