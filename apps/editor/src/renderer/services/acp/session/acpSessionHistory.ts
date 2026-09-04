/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionHistoryService — durable, agent-anchored session metadata.
 *
 *  We persist the minimum required to resume a session against an ACP agent
 *  that advertises `agentCapabilities.loadSession: true`:
 *    - sessionIdOnAgent: the id the agent owns (replayed via `session/load`)
 *    - agentId / cwd:    used to respawn the agent with the same sandbox root
 *    - title / timestamps: pure UX
 *  The conversation messages themselves stay on the agent side; we never try
 *  to mirror them locally.
 *
 *  Storage uses IStorageService via `PersistedStateBase` with a workspace-first
 *  + global-fallback policy: when a folder is open the entries live in
 *  WORKSPACE scope so each workspace keeps its own history; with no folder
 *  open we read/write GLOBAL as a fallback bucket.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  observableValue,
  registerSingleton,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import type { AcpPlanEntry } from './acpSessionModel.js'
import { isPromptEchoTitle } from './acpSessionTitleEcho.js'

/**
 * Which sessions the Agents history surfaces:
 *  - `workspace`: only sessions whose cwd equals the open folder.
 *  - `worktree`:  sessions from the open folder AND its sibling git worktrees
 *                 (the agent's `session/list` already returns these because the
 *                 SDK defaults `includeWorktrees: true`).
 *  - `all`:       sessions across every project the agent knows about.
 */
export type SessionHistoryScope = 'workspace' | 'worktree' | 'all'

export interface AcpSessionHistoryEntry {
  /**
   * The agent-issued session id from `session/new` — durable across editor
   * restarts. Identical to `sessionIdOnAgent`; kept as `id` for ergonomics on
   * the lookup/index side. The duplicate `sessionIdOnAgent` field is retained
   * so callers can still talk in protocol terms without grepping the schema.
   */
  readonly id: string
  readonly agentId: string
  /** Equal to `id`. Kept for protocol-side clarity and bulk-merge keying. */
  readonly sessionIdOnAgent: string
  readonly title: string
  /** Workspace cwd at creation time. Optional because users may run agent-only. */
  readonly cwd?: string
  /**
   * The `remote-ssh` authority this session ran on. Absent for local sessions.
   * For a remote session `cwd` is a remote POSIX path; this field routes its
   * spawn/resume back to the same host.
   */
  readonly authority?: string
  /**
   * Git branch reported by the agent for this session (end-of-session branch).
   * Used to label rows when the history scope spans worktrees. Optional — not
   * all agents report it and non-git sessions have none.
   */
  readonly branch?: string
  /**
   * Absolute path to the session's transcript file (claude: the `.jsonl` under
   * `~/.claude/projects/<encoded-cwd>/`; codex: the thread's rollout `.jsonl`),
   * reported by the agent via `SessionInfo._meta.transcriptPath`. Optional —
   * agents with no per-session transcript file (or ephemeral threads) omit it.
   * Used by the "Reveal Session Location" command to show the file in the OS
   * file manager.
   */
  readonly transcriptPath?: string
  /** Unix epoch milliseconds. */
  readonly createdAt: number
  /** Unix epoch milliseconds — updated on resume + on outbound prompt. */
  readonly lastUsedAt: number
  /**
   * Cached configOption selections (configId → currentValue) — replayed back
   * after `session/load` so MODEL/MODE survive editor restart. ACP itself
   * keeps the state on the agent side; we mirror it here per-session.
   */
  readonly configOptions?: Readonly<Record<string, string>>
  /**
   * Friendly display names paired with {@link configOptions} (configId → name).
   * Mirrored so the sidebar can show the model / effort label on a row that is
   * no longer live (where the option's `options` list — which maps value→name —
   * is unavailable). Falls back to the raw value when absent.
   */
  readonly configLabels?: Readonly<Record<string, string>>
  /**
   * Latest context-window usage snapshot the agent reported via `usage_update`.
   * Mirrored here so the usage arc can be restored on resume — `session/load`
   * replay does not re-emit `usage_update`, so without this snapshot the arc
   * stays blank until the user sends another prompt.
   */
  readonly usage?: {
    readonly used: number
    readonly size: number
    readonly cost?: { readonly amount: number; readonly currency: string }
    readonly models?: ReadonlyArray<{
      readonly model: string
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
      readonly cacheCreateTokens: number
      readonly costUSD?: number
    }>
    /** True when cost/models are locally estimated (Codex) rather than agent-reported. */
    readonly costEstimated?: boolean
  }
  /**
   * Latest plan snapshot the agent reported via `sessionUpdate: 'plan'`
   * (whole-list, last-wins). Mirrored here so the StickyPlanBar can be
   * restored on resume — the codex fork's `session/load` replay does not
   * re-emit plan updates, so without this snapshot the plan bar stays blank
   * after an editor restart.
   */
  readonly plan?: readonly AcpPlanEntry[]
  /** Timeline collapse mode persisted per-session so it survives editor restarts. */
  readonly collapseMode?: CollapseMode
  /** Cumulative milliseconds the session spent in 'running' status. Updated each time a run segment ends. */
  readonly accumulatedRunningMs?: number
  /**
   * Full text of the session's first content-bearing user prompt (local
   * built-in commands like `/model` and quote-only prefills excluded), capped
   * at {@link FIRST_PROMPT_MAX_LENGTH}. Write-once — never rewritten by later
   * prompts and never clobbered by an AI/manual title. Powers the session
   * list's hover tooltip, where the (possibly AI-renamed) title no longer
   * tells the user what the session started with.
   */
  readonly firstPrompt?: string
  /**
   * True once the user has sent at least one message in this session. Unset
   * (or explicitly `false`) for sessions that were created but never used.
   * Used by the restore coordinator to skip sessions the agent never persisted.
   */
  readonly hasMessages?: boolean
  /**
   * True once an AI-model-generated title has been set for this session. Such a
   * title is also pushed back to the agent (`renameSession`), but until the next
   * hydrate confirms it, this flag stops the `session/list` `summary` (which
   * falls back to the first prompt after `/compact`) from clobbering it locally.
   * It also protects agents that can't persist titles at all (e.g. codex).
   */
  readonly aiTitle?: boolean
  /**
   * True once the user manually renamed this session. Like {@link aiTitle} it
   * blocks the `session/list` `summary` from clobbering the title on hydrate,
   * but it ranks *above* an AI title: once set, {@link AcpSession} also stops
   * regenerating an AI title so a user-chosen name is never overwritten.
   */
  readonly manualTitle?: boolean
  /**
   * True once the title was derived locally from the session's first prompt.
   * Ranks *below* {@link aiTitle} (an AI title lands over it via the authoritative
   * `overwriteProtectedTitle` channel) but *above* the agent's reported summary:
   * without a session-title model the SDK summary falls back to `lastPrompt`, so
   * the agent re-reports the newest prompt as the title at every turn end. Unlike
   * the other two flags this title is never pushed to the agent — writing a
   * 30-char prompt slice as the agent's `customTitle` would both impersonate a
   * user rename and permanently suppress the SDK's own background `aiTitle`.
   */
  readonly derivedTitle?: boolean
  /**
   * True once the user archived this session. Archived rows are hidden from the
   * session list by default (the filter popover's "Archived" toggle reveals
   * them, sunk to the bottom and dimmed). Purely a local UX flag — the agent
   * side is never notified, and archiving a live session neither closes nor
   * cancels it.
   */
  readonly archived?: boolean
  /**
   * True once the user pinned this session. Pinned rows sort first in the
   * session list and are exempt from the MAX_ENTRIES eviction (see
   * {@link AcpSessionHistoryService._evictOverflow}).
   */
  readonly pinned?: boolean
  /**
   * Per-session MCP whitelist: the server names (from the `acp.mcpServers` +
   * project `.mcp.json` pool) this session runs with. Absent = inherit the
   * current defaults (per-agent saved default, else every non-disabled pool
   * entry). A pinned list is frozen — servers added to the pool later do NOT
   * flow into this session until the user re-enables inheritance.
   */
  readonly mcpServerNames?: readonly string[]
  /**
   * Parent session id (`sessionIdOnAgent`) when this row is a **side task**
   * forked from another session ("ask in side chat"). Side tasks are hidden
   * from the session list and surfaced through the parent chat's SideTasksBar
   * popover instead. Unset for regular sessions.
   */
  readonly sideTaskOf?: string
  /**
   * The text selection the side task was created from, kept so the side chat's
   * quote bar can re-render the chip/preview after a restart.
   */
  readonly sideTaskQuote?: string
  /**
   * The client-generated messageId of the side task's first own user prompt —
   * the boundary between the forked baseline and the side task's own turns. On
   * a re-open the replay suppresses everything up to this message, then keeps
   * the side task's own turns from here on. Unset until the first turn is sent.
   */
  readonly sideTaskAnchorMessageId?: string
  /**
   * Anchor ids of user prompts retracted by cancelTurn's restore (the draft
   * went back to the input box). They stay in the agent transcript, so the
   * resume replay filters them — and the trailing
   * `[Request interrupted by user]` marker — back out of the timeline.
   */
  readonly retractedMessageIds?: readonly string[]
  /**
   * True when this session was created by the AI Fix code action. Its config
   * selections never write back to the per-agent defaults (the session's
   * config-option state machine is built with `suppressDefaults`); the flag is
   * persisted so a resume rebuilds the same isolation.
   */
  readonly aiFix?: boolean
}

export interface IAcpSessionHistoryService {
  readonly _serviceBrand: undefined
  readonly entries: IObservable<readonly AcpSessionHistoryEntry[]>
  /** Idempotent: safe to call multiple times. main.tsx fire-and-forgets. */
  initialize(): Promise<void>
  list(): readonly AcpSessionHistoryEntry[]
  get(id: string): AcpSessionHistoryEntry | undefined
  /** Returns the new entry (caller usually only needs the id). */
  add(
    entry: Omit<AcpSessionHistoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>,
  ): AcpSessionHistoryEntry
  /** Bump lastUsedAt; no-op if id is unknown. */
  touch(id: string): void
  /**
   * Move a row onto a new agent-issued session id, keeping every other field
   * (title flags, config snapshot, cwd/authority, MCP pin, createdAt, …). Used
   * when an EMPTY session is rebuilt with `session/new` during a hot reconnect:
   * the agent hands out a fresh durable id, but from the user's point of view it
   * is still the same session (same tab, same draft, same local id). No-op when
   * `oldId` is unknown or the ids are equal.
   */
  rekey(oldId: string, newId: string): void
  remove(id: string): void
  clear(): void
  /**
   * Patch a single configOption value (and optional friendly label) on a
   * history entry. No-op if id is unknown. Used by `AcpSession.setConfigOption`
   * to mirror user-driven selections so they survive editor restart.
   */
  setHistoryConfigOption(sessionId: string, configId: string, value: string, label?: string): void
  /**
   * Persist the timeline collapse mode for a session. No-op if id is unknown
   * or the value is unchanged.
   */
  setHistoryCollapseMode(sessionId: string, mode: CollapseMode): void
  /**
   * Mirror the latest usage snapshot onto a history entry. No-op if id is
   * unknown or the snapshot is unchanged. Called by `AcpSession.applyUpdate`
   * on every `usage_update` so the arc can be restored after resume.
   */
  setHistoryUsage(sessionId: string, usage: AcpSessionHistoryEntry['usage']): void
  /**
   * Mirror the latest plan snapshot onto a history entry. `null` clears the
   * mirror (the agent emitted an empty plan, or a rewind reset the replay
   * state). No-op if id is unknown or the snapshot is unchanged. Called by
   * `AcpSession.applyUpdate` on every `plan` update so the StickyPlanBar can
   * be restored after resume.
   */
  setHistoryPlan(sessionId: string, plan: readonly AcpPlanEntry[] | null): void
  /**
   * Accumulate the total running duration for a session. No-op if id is
   * unknown. Called each time a 'running' segment ends (transition to idle /
   * errored / closed) so it survives editor restarts.
   */
  setHistoryRunningDuration(sessionId: string, ms: number): void
  /**
   * Mark a session as having at least one user message. Idempotent.
   * No-op if the session id is unknown. Called by `AcpSession.sendPrompt`
   * so the restore coordinator can skip sessions that were created but
   * never used (the agent does not persist those across restarts).
   */
  setHistoryHasMessages(sessionId: string): void
  /**
   * Record the session's first content-bearing user prompt in full (see
   * {@link AcpSessionHistoryEntry.firstPrompt}). Write-once: ignored when the
   * row already has one or the id is unknown.
   */
  setHistoryFirstPrompt(sessionId: string, text: string): void
  /**
   * Records the side task's anchor messageId (its first own user prompt).
   * Write-once: ignored when the row already has an anchor or the id is
   * unknown. Called by `AcpSession.sendPrompt` so a re-open can tell the
   * forked baseline apart from the side task's own turns.
   */
  setSideTaskAnchorMessageId(sessionId: string, messageId: string): void
  /**
   * Record a user prompt retracted by cancelTurn's restore (see
   * {@link AcpSessionHistoryEntry.retractedMessageIds}). Deduped; no-op if the
   * id is unknown.
   */
  addRetractedMessageId(sessionId: string, messageId: string): void
  /**
   * Mark a session's title as AI-generated. Idempotent; no-op if the id is
   * unknown. Called by `AcpSession` when it sets a title from the session-title
   * model so the hydrate sweep won't overwrite it with the agent's first-prompt
   * `summary`.
   */
  setHistoryAiTitle(sessionId: string): void
  /**
   * Mark a session's title as manually renamed by the user. Idempotent; no-op
   * if the id is unknown. Ranks above {@link setHistoryAiTitle}: it protects the
   * title from hydrate overwrites AND signals the session to stop regenerating
   * an AI title.
   */
  setHistoryManualTitle(sessionId: string): void
  /**
   * Mark a session's title as locally derived from its first prompt. Idempotent;
   * no-op if the id is unknown. Protects the title from the agent's reported
   * summary (which without a session-title model echoes the newest prompt), but
   * yields to an AI/manual title.
   */
  setHistoryDerivedTitle(sessionId: string): void
  /**
   * Set (or clear, with `false`) the archived flag. Idempotent; no-op if the
   * id is unknown or the value is unchanged. Never touches the live session —
   * archiving is a list-level marker only.
   */
  setHistoryArchived(sessionId: string, archived: boolean): void
  /**
   * Set (or clear, with `false`) the pinned flag. Idempotent; no-op if the id
   * is unknown or the value is unchanged.
   */
  setHistoryPinned(sessionId: string, pinned: boolean): void
  /**
   * Record the session's transcript file path (see
   * {@link AcpSessionHistoryEntry.transcriptPath}). Idempotent; no-op if the id
   * is unknown or the value is unchanged. Used by the on-demand reveal lookup —
   * the path normally arrives via the hydrate sweep, which a session created
   * during this window's lifetime has not seen yet.
   */
  setHistoryTranscriptPath(sessionId: string, path: string): void
  /**
   * Persist the session's MCP whitelist ({@link AcpSessionHistoryEntry.mcpServerNames}).
   * `null` clears the pin (back to inheriting the defaults). No-op if the id is
   * unknown or the value is unchanged.
   */
  setHistoryMcpServerNames(sessionId: string, names: readonly string[] | null): void
  /**
   * Bulk-merge protocol-reported sessions for one agent. Used by the hydrate
   * sweep that polls each agent's `session/list`. Rows are upserted by
   * (agentId, sessionIdOnAgent); existing configOptions are preserved;
   * lastUsedAt = max(protocol updatedAt, local lastUsedAt). Sorts the final
   * snapshot by lastUsedAt desc and truncates to MAX_ENTRIES.
   *
   * `currentCwd` is the workspace cwd at the moment the hydrate fired and acts
   * as a defense-in-depth filter — even if an agent ignores the `cwd` param
   * we passed to `session/list` and returns sessions from other workspaces,
   * we will not merge them into the current bucket. When `currentCwd` is
   * undefined (empty window) the call is a no-op so the GLOBAL fallback
   * bucket stays empty.
   *
   * `authority` is the remote authority this sweep targeted: every reported
   * row is attributed to it. Local sweeps pass undefined.
   *
   * `scope` controls how strict the cwd filter is: `workspace` keeps only
   * exact-cwd rows; `worktree`/`all` trust the sweep's own scoping and accept
   * every reported session (so sibling-worktree / cross-project rows survive).
   */
  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    authority: string | undefined,
    scope: SessionHistoryScope,
  ): void
  /**
   * Replace semantics for a user-initiated refresh: upsert every reported
   * session like `bulkMergeFromAgent`, AND prune any existing entry for this
   * agent (with a known cwd) that is absent from the new list and not in
   * `preserveIds`. `preserveIds` should carry the currently-live session
   * historyIds so a session that hasn't been listed yet (e.g. just-created)
   * does not get pruned from under the UI.
   *
   * The prune domain follows `scope` unless `pruneDomain: 'sweep'` is passed:
   * - `'sweep'`: only rows whose cwd exactly equals `currentCwd` are eligible.
   *   Used by the restore coordinator's sub-root hydrates, where the workspace
   *   root and sibling sub-roots own the rest of the rows — pruning them here
   *   would delete sessions another sweep just reported.
   * - `workspace` scope: only exact-`currentCwd` rows are eligible (other
   *   workspaces survive).
   * - `worktree` scope: every known-cwd row EXCEPT strict subdirectories of
   *   `currentCwd` is eligible. Subdirectory rows belong to their own sub-root
   *   sweeps; pruning them from the root sweep would both lose local-only
   *   fields (the sub-root sweep would rebuild the row from scratch) and
   *   starve `_derivedSubRoots`, which reads the history to find extra roots.
   * - `all` scope: any known-cwd row is eligible — the `all` sweep drops the
   *   cwd filter on `session/list` and therefore owns every project.
   *
   * Entries with a missing `cwd` are always left alone (we cannot tell which
   * workspace they belong to). Entries for other agents are untouched.
   *
   * Called by the Refresh Session List button via the coordinator.
   */
  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    authority: string | undefined,
    preserveIds: ReadonlySet<string>,
    scope: SessionHistoryScope,
    pruneDomain?: 'scope' | 'sweep',
  ): void
  /**
   * Patch metadata for one entry from a `session_info_update` notification.
   * No-op if id is unknown.
   *
   * Like the hydrate sweep and upsert, an `aiTitle`/`manualTitle` row keeps its
   * title: the agent-reported summary reverts to the first prompt after
   * `/compact` (or when the rename push never landed) and must not clobber it.
   * Callers writing an authoritative title (AI-title application, manual
   * rename) pass `overwriteProtectedTitle`.
   */
  updateInfo(
    sessionId: string,
    patch: { title?: string; updatedAt?: number },
    opts?: { overwriteProtectedTitle?: boolean },
  ): void
}

/** Shape we accept from the protocol's `SessionInfo` — kept structural to avoid leaking SDK types into the history interface. */
export interface BulkMergeSessionInfo {
  readonly sessionId: string
  /**
   * Optional — some agents omit cwd. When absent, the entry is tolerated
   * (existing.cwd wins on upsert); when present, it must match the current
   * workspace cwd or the entry is dropped.
   */
  readonly cwd?: string | null
  readonly title?: string | null
  readonly updatedAt?: string | null
  /** Git branch reported via the agent's `SessionInfo._meta.gitBranch`, if any. */
  readonly branch?: string | null
  /** Transcript file path reported via `SessionInfo._meta.transcriptPath`, if any. */
  readonly transcriptPath?: string | null
}

/** True when `child` equals `parent` or resolves beneath it (platform-aware,
 *  case-folded on win32/darwin). Both must be defined — a missing path is never
 *  treated as "under" anything. `relativePathUnder` returns `''` for equality
 *  and `null` when the child escapes the parent, so a non-null result is exactly
 *  the descendant-or-equal relation. */
export function isDescendantOrEqual(
  uriIdentity: IUriIdentityService,
  parent: string | undefined,
  child: string | undefined,
): boolean {
  if (parent === undefined || child === undefined) return false
  return uriIdentity.relativePathUnder(parent, child) !== null
}

/**
 * Relative path of a session cwd beneath the workspace root — the single source
 * of the "strict subdirectory" judgement shared by the chat cwd pill and the
 * editor-tab folder badge. Returns null for a root-level cwd, an unknown cwd,
 * or a cwd outside the workspace (those need no scope badge).
 */
export function sessionCwdScopeRel(
  uriIdentity: IUriIdentityService,
  rootFsPath: string | undefined,
  cwd: string | undefined,
): string | null {
  if (rootFsPath === undefined || cwd === undefined) return null
  const rel = uriIdentity.relativePathUnder(rootFsPath, cwd)
  return rel === null || rel === '' ? null : rel
}

/**
 * Whether a history entry belongs to a *different* workspace than the open
 * folder (split-brain guard): its cwd is neither equal to nor beneath
 * `currentCwd`, or its effective authority differs from `currentAuthority`.
 * An entry with no cwd — or an empty window with no `currentCwd` — is treated
 * as "belongs here" for legacy/global compatibility. A **subdirectory** of the
 * current cwd is NOT foreign: that is the same workspace, so it stays
 * live-resumable, renameable, and visible in `workspace` scope.
 *
 * Authority is resolved internally so every caller gets the same cross-host
 * verdict. This is the single source of truth for the service guards, the
 * resume picker and the session-list / editor surfaces — do NOT re-derive it
 * inline with `arePathsEqual`, that is exactly the split-brain this function
 * exists to prevent.
 *
 * Caveat inherited from `relativePathUnder`: the path primitives fold case by
 * the *host* platform, so a win32 client comparing remote POSIX paths is
 * case-insensitive. Authority still separates hosts, so this only matters for
 * two remote paths on the same host differing solely in case.
 */
export function isForeignWorkspaceSession(
  entry: Pick<AcpSessionHistoryEntry, 'cwd' | 'authority'>,
  currentCwd: string | undefined,
  currentAuthority: string | undefined,
  uriIdentity: IUriIdentityService,
): boolean {
  if (entry.cwd === undefined || currentCwd === undefined) return false
  if (!isDescendantOrEqual(uriIdentity, currentCwd, entry.cwd)) return true
  // Past this point the cwd lies inside the open folder, so a legacy row that
  // predates persisted authorities belongs to this window's host.
  return entry.authority !== undefined && entry.authority !== currentAuthority
}

/** Legacy rows created before the hydrate sweep persisted `authority` lack the
 *  field — when their cwd lies inside the current workspace, attribute them to
 *  the current window's authority. Cross-worktree legacy rows are never guessed.
 *
 *  The membership test must stay the same relation `isForeignWorkspaceSession`
 *  uses (descendant-or-equal, not exact equality): a legacy **subdirectory** row
 *  is judged non-foreign there and therefore reaches resume, so backfilling only
 *  exact-cwd rows would connect it with no authority — spawning the agent on the
 *  local machine against a remote path. */
export function effectiveEntryAuthority(
  entry: Pick<AcpSessionHistoryEntry, 'cwd' | 'authority'>,
  currentCwd: string | undefined,
  currentAuthority: string | undefined,
  uriIdentity: IUriIdentityService,
): string | undefined {
  if (entry.authority !== undefined) return entry.authority
  if (currentAuthority !== undefined && isDescendantOrEqual(uriIdentity, currentCwd, entry.cwd)) {
    return currentAuthority
  }
  return undefined
}

/** Collect a side task together with every descendant reachable through the
 *  `sideTaskOf` chain (a side task can itself be forked into further side
 *  tasks), root first. Deleting only the clicked row would orphan its children:
 *  they are hidden from the session list, and their only entry point — the
 *  parent chat's SideTasksBar — disappears with the parent. `visited` makes a
 *  malformed parent cycle in persisted rows terminate. */
export function collectSideTaskDescendants(
  entries: readonly AcpSessionHistoryEntry[],
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.sideTaskOf === undefined) continue
    const siblings = childrenByParent.get(entry.sideTaskOf)
    if (siblings) siblings.push(entry.id)
    else childrenByParent.set(entry.sideTaskOf, [entry.id])
  }
  const collected: string[] = []
  const visited = new Set<string>()
  const pending = [rootId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    collected.push(id)
    const children = childrenByParent.get(id)
    if (children) pending.push(...children)
  }
  return collected
}

export const IAcpSessionHistoryService = createDecorator<IAcpSessionHistoryService>(
  'acpSessionHistoryService',
)

const STORAGE_KEY = 'acp.sessionHistory'
const SCHEMA_VERSION = 5
const MAX_ENTRIES = 100

/**
 * Cap on the persisted first-prompt text. A bound is needed because the field
 * rides the whole-file history serialization on every write; 4000 chars is far
 * beyond any realistic first prompt yet keeps pathological pastes from
 * inflating the storage blob.
 */
export const FIRST_PROMPT_MAX_LENGTH = 4000

interface PersistedShape {
  readonly schemaVersion: number
  readonly entries: readonly AcpSessionHistoryEntry[]
}

export class AcpSessionHistoryService
  extends PersistedStateBase<AcpSessionHistoryEntry[]>
  implements IAcpSessionHistoryService
{
  declare readonly _serviceBrand: undefined

  readonly entries: ISettableObservable<readonly AcpSessionHistoryEntry[]>

  private readonly _uriIdentity: IUriIdentityService

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IUriIdentityService uriIdentity: IUriIdentityService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpSessionHistory',
      loggerName: 'ACP History',
      persistFailureEvent: 'acp.session_history_persist_failed',
    })
    this._uriIdentity = uriIdentity
    this.entries = observableValue<readonly AcpSessionHistoryEntry[]>('acp.sessionHistory', [])
  }

  list(): readonly AcpSessionHistoryEntry[] {
    return this._state
  }

  get(id: string): AcpSessionHistoryEntry | undefined {
    return this._state.find((e) => e.id === id)
  }

  add(
    entry: Omit<AcpSessionHistoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>,
  ): AcpSessionHistoryEntry {
    const now = Date.now()
    // The canonical id is the agent-issued sessionId. Re-adding the same
    // (agentId, sessionIdOnAgent) tuple updates the existing row in-place
    // rather than producing a duplicate.
    const id = entry.sessionIdOnAgent
    const existingIdx = this._state.findIndex(
      (e) => e.agentId === entry.agentId && e.sessionIdOnAgent === entry.sessionIdOnAgent,
    )
    const createdAt = existingIdx >= 0 ? this._state[existingIdx]!.createdAt : now
    // Preserve any prior configOptions cache if the caller didn't supply one —
    // re-adding the same session shouldn't blow away saved MODEL/MODE state.
    const carriedConfigOptions =
      entry.configOptions ??
      (existingIdx >= 0 ? this._state[existingIdx]!.configOptions : undefined)
    const carriedConfigLabels =
      entry.configLabels ?? (existingIdx >= 0 ? this._state[existingIdx]!.configLabels : undefined)
    // Likewise preserve any prior usage snapshot — re-adding the same session
    // (e.g. on resume) must not blow away the restored arc.
    const carriedUsage =
      entry.usage ?? (existingIdx >= 0 ? this._state[existingIdx]!.usage : undefined)
    // And the plan snapshot — re-adding on resume must keep the restored bar.
    const carriedPlan =
      entry.plan ?? (existingIdx >= 0 ? this._state[existingIdx]!.plan : undefined)
    // Once hasMessages is true it must never revert. Input value takes
    // precedence; fall back to the existing row so resume() preserves it.
    const carriedHasMessages = (() => {
      const existing = existingIdx >= 0 ? this._state[existingIdx]!.hasMessages : undefined
      if (existing === true) return true
      return entry.hasMessages
    })()
    // Preserve a prior AI-title / manual-title / derived-title flag + its title
    // across re-add (the construct-time `entry.title` is the default placeholder,
    // not the user-chosen / AI / derived title). Manual ranks above AI above derived.
    const existingAiTitle = existingIdx >= 0 ? this._state[existingIdx]!.aiTitle : undefined
    const existingManualTitle = existingIdx >= 0 ? this._state[existingIdx]!.manualTitle : undefined
    const existingDerivedTitle =
      existingIdx >= 0 ? this._state[existingIdx]!.derivedTitle : undefined
    const title =
      existingManualTitle === true || existingAiTitle === true || existingDerivedTitle === true
        ? this._state[existingIdx]!.title
        : entry.title
    // Same carry-over for the MCP whitelist: re-adding the session (e.g. on a
    // post-pick reload) must keep the user's pinned selection.
    const carriedMcpServerNames =
      entry.mcpServerNames ??
      (existingIdx >= 0 ? this._state[existingIdx]!.mcpServerNames : undefined)
    // Side-task parentage/quote: forked once at creation, carried across re-adds.
    const carriedSideTaskOf =
      entry.sideTaskOf ?? (existingIdx >= 0 ? this._state[existingIdx]!.sideTaskOf : undefined)
    const carriedSideTaskQuote =
      entry.sideTaskQuote ??
      (existingIdx >= 0 ? this._state[existingIdx]!.sideTaskQuote : undefined)
    // The anchor is recorded once by setSideTaskAnchorMessageId — carried so a
    // re-add (e.g. on resume) doesn't lose the replay boundary.
    const carriedSideTaskAnchorMessageId =
      entry.sideTaskAnchorMessageId ??
      (existingIdx >= 0 ? this._state[existingIdx]!.sideTaskAnchorMessageId : undefined)
    // First prompt is write-once; a re-add (e.g. on resume) must not drop it.
    const carriedFirstPrompt =
      entry.firstPrompt ?? (existingIdx >= 0 ? this._state[existingIdx]!.firstPrompt : undefined)
    // Cancel-retractions accumulate across turns; a re-add must keep them.
    const carriedRetractedMessageIds =
      entry.retractedMessageIds ??
      (existingIdx >= 0 ? this._state[existingIdx]!.retractedMessageIds : undefined)
    // Same carry-over for the transcript path: re-adding must not drop it.
    const carriedTranscriptPath =
      entry.transcriptPath ??
      (existingIdx >= 0 ? this._state[existingIdx]!.transcriptPath : undefined)
    // AI Fix isolation: set once at creation, carried across re-adds (resume).
    const carriedAiFix =
      entry.aiFix ?? (existingIdx >= 0 ? this._state[existingIdx]!.aiFix : undefined)
    // Remote authority is set once at creation and carried across re-adds.
    const carriedAuthority =
      entry.authority ?? (existingIdx >= 0 ? this._state[existingIdx]!.authority : undefined)
    const next: AcpSessionHistoryEntry = {
      id,
      agentId: entry.agentId,
      sessionIdOnAgent: entry.sessionIdOnAgent,
      title,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(carriedAuthority !== undefined ? { authority: carriedAuthority } : {}),
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      createdAt,
      lastUsedAt: now,
      ...(carriedConfigOptions !== undefined ? { configOptions: carriedConfigOptions } : {}),
      ...(carriedConfigLabels !== undefined ? { configLabels: carriedConfigLabels } : {}),
      ...(carriedUsage !== undefined ? { usage: carriedUsage } : {}),
      ...(carriedPlan !== undefined ? { plan: carriedPlan } : {}),
      ...(carriedMcpServerNames !== undefined ? { mcpServerNames: carriedMcpServerNames } : {}),
      ...(carriedSideTaskOf !== undefined ? { sideTaskOf: carriedSideTaskOf } : {}),
      ...(carriedSideTaskQuote !== undefined ? { sideTaskQuote: carriedSideTaskQuote } : {}),
      ...(carriedSideTaskAnchorMessageId !== undefined
        ? { sideTaskAnchorMessageId: carriedSideTaskAnchorMessageId }
        : {}),
      ...(existingIdx >= 0 && this._state[existingIdx]!.collapseMode !== undefined
        ? { collapseMode: this._state[existingIdx]!.collapseMode }
        : {}),
      ...(carriedHasMessages !== undefined ? { hasMessages: carriedHasMessages } : {}),
      ...(carriedFirstPrompt !== undefined ? { firstPrompt: carriedFirstPrompt } : {}),
      ...(carriedRetractedMessageIds !== undefined
        ? { retractedMessageIds: carriedRetractedMessageIds }
        : {}),
      ...(carriedTranscriptPath !== undefined ? { transcriptPath: carriedTranscriptPath } : {}),
      ...(carriedAiFix !== undefined ? { aiFix: carriedAiFix } : {}),
      ...(existingAiTitle === true ? { aiTitle: true } : {}),
      ...(existingManualTitle === true ? { manualTitle: true } : {}),
      ...(existingDerivedTitle === true ? { derivedTitle: true } : {}),
      // Same carry-over for the archive/pin flags: re-adding the same session
      // (e.g. on resume) must not drop the user's list-level markers.
      ...(existingIdx >= 0 && this._state[existingIdx]!.archived === true
        ? { archived: true }
        : {}),
      ...(existingIdx >= 0 && this._state[existingIdx]!.pinned === true ? { pinned: true } : {}),
    }
    if (existingIdx >= 0) {
      this._state = [next, ...this._state.filter((_, i) => i !== existingIdx)]
    } else {
      this._state = [next, ...this._state]
    }
    this._truncate()
    this._publish()
    this._scheduleWrite()
    return next
  }

  touch(id: string): void {
    const idx = this._state.findIndex((e) => e.id === id)
    if (idx === -1) return
    const cur = this._state[idx]!
    const next: AcpSessionHistoryEntry = { ...cur, lastUsedAt: Date.now() }
    this._state = [next, ...this._state.filter((_, i) => i !== idx)]
    this._publish()
    this._scheduleWrite()
  }

  rekey(oldId: string, newId: string): void {
    if (oldId === newId || newId.length === 0) return
    const idx = this._state.findIndex((e) => e.id === oldId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const next: AcpSessionHistoryEntry = {
      ...cur,
      id: newId,
      sessionIdOnAgent: newId,
      lastUsedAt: Date.now(),
    }
    // Drop the old row AND any pre-existing row already sitting on newId, so a
    // rebuild can never leave two rows describing the same session.
    this._state = [next, ...this._state.filter((e) => e.id !== oldId && e.id !== newId)]
    this._publish()
    this._scheduleWrite()
  }

  remove(id: string): void {
    const before = this._state.length
    this._state = this._state.filter((e) => e.id !== id)
    if (this._state.length !== before) {
      this._publish()
      this._scheduleWrite()
    }
  }

  clear(): void {
    if (this._state.length === 0) return
    this._state = []
    this._publish()
    this._scheduleWrite()
  }

  setHistoryConfigOption(sessionId: string, configId: string, value: string, label?: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const prevOpts = cur.configOptions ?? {}
    const prevLabels = cur.configLabels ?? {}
    const sameValue = prevOpts[configId] === value
    const sameLabel = label === undefined || prevLabels[configId] === label
    if (sameValue && sameLabel) return
    const nextOpts: Readonly<Record<string, string>> = { ...prevOpts, [configId]: value }
    const nextLabels: Readonly<Record<string, string>> =
      label !== undefined ? { ...prevLabels, [configId]: label } : prevLabels
    const next: AcpSessionHistoryEntry = {
      ...cur,
      configOptions: nextOpts,
      ...(label !== undefined ? { configLabels: nextLabels } : {}),
    }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryCollapseMode(sessionId: string, mode: CollapseMode): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.collapseMode === mode) return
    const next: AcpSessionHistoryEntry = { ...cur, collapseMode: mode }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryUsage(sessionId: string, usage: AcpSessionHistoryEntry['usage']): void {
    if (usage === undefined) return
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (sameUsage(cur.usage, usage)) return
    const next: AcpSessionHistoryEntry = { ...cur, usage }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryPlan(sessionId: string, plan: readonly AcpPlanEntry[] | null): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const nextPlan = plan === null ? undefined : plan
    if (samePlan(cur.plan, nextPlan)) return
    // exactOptionalPropertyTypes: clearing must rebuild the entry without the key.
    const { plan: _drop, ...base } = cur
    const next: AcpSessionHistoryEntry = nextPlan === undefined ? base : { ...base, plan: nextPlan }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryRunningDuration(sessionId: string, ms: number): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.accumulatedRunningMs === ms) return
    const next: AcpSessionHistoryEntry = { ...cur, accumulatedRunningMs: ms }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryHasMessages(sessionId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.hasMessages === true) return
    const next: AcpSessionHistoryEntry = { ...cur, hasMessages: true }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryFirstPrompt(sessionId: string, text: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.firstPrompt !== undefined) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const next: AcpSessionHistoryEntry = {
      ...cur,
      firstPrompt:
        trimmed.length > FIRST_PROMPT_MAX_LENGTH
          ? trimmed.slice(0, FIRST_PROMPT_MAX_LENGTH)
          : trimmed,
    }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setSideTaskAnchorMessageId(sessionId: string, messageId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.sideTaskAnchorMessageId !== undefined) return
    const next: AcpSessionHistoryEntry = { ...cur, sideTaskAnchorMessageId: messageId }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  addRetractedMessageId(sessionId: string, messageId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.retractedMessageIds?.includes(messageId)) return
    const next: AcpSessionHistoryEntry = {
      ...cur,
      retractedMessageIds: [...(cur.retractedMessageIds ?? []), messageId],
    }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryAiTitle(sessionId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.aiTitle === true) return
    const next: AcpSessionHistoryEntry = { ...cur, aiTitle: true }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryManualTitle(sessionId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.manualTitle === true) return
    const next: AcpSessionHistoryEntry = { ...cur, manualTitle: true }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryDerivedTitle(sessionId: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.derivedTitle === true) return
    const next: AcpSessionHistoryEntry = { ...cur, derivedTitle: true }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryArchived(sessionId: string, archived: boolean): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if ((cur.archived === true) === archived) return
    // exactOptionalPropertyTypes: clearing must rebuild the entry without the
    // key — `{...cur, archived: undefined}` is not assignable.
    const { archived: _drop, ...base } = cur
    const next: AcpSessionHistoryEntry = archived ? { ...base, archived: true } : base
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryPinned(sessionId: string, pinned: boolean): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if ((cur.pinned === true) === pinned) return
    const { pinned: _drop, ...base } = cur
    const next: AcpSessionHistoryEntry = pinned ? { ...base, pinned: true } : base
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryTranscriptPath(sessionId: string, path: string): void {
    if (path.length === 0) return
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    if (cur.transcriptPath === path) return
    const next: AcpSessionHistoryEntry = { ...cur, transcriptPath: path }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  setHistoryMcpServerNames(sessionId: string, names: readonly string[] | null): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const nextNames = names === null ? undefined : [...names]
    if (sameStringArray(cur.mcpServerNames, nextNames)) return
    // exactOptionalPropertyTypes: present-with-undefined is not assignable, so
    // clearing the pin must rebuild the entry without the key.
    const { mcpServerNames: _drop, ...base } = cur
    const next: AcpSessionHistoryEntry =
      nextNames === undefined ? base : { ...base, mcpServerNames: nextNames }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._publish()
    this._scheduleWrite()
  }

  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    authority: string | undefined,
    scope: SessionHistoryScope,
  ): void {
    if (sessions.length === 0) return
    this._mergeOrReplace(agentId, sessions, currentCwd, authority, undefined, scope, 'scope')
  }

  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    authority: string | undefined,
    preserveIds: ReadonlySet<string>,
    scope: SessionHistoryScope,
    pruneDomain?: 'scope' | 'sweep',
  ): void {
    // Empty bucket protection: same as bulkMergeFromAgent. Without a workspace
    // we don't know which rows to prune, so leave everything alone.
    if (currentCwd === undefined) return
    this._mergeOrReplace(
      agentId,
      sessions,
      currentCwd,
      authority,
      preserveIds,
      scope,
      pruneDomain ?? 'scope',
    )
  }

  private _mergeOrReplace(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    authority: string | undefined,
    preserveIds: ReadonlySet<string> | undefined,
    scope: SessionHistoryScope,
    pruneDomain: 'scope' | 'sweep',
  ): void {
    // Empty window: refuse to absorb anything the agent reports. Otherwise a
    // hydrate fired before the user opens a folder would pollute the GLOBAL
    // fallback bucket with sessions from every prior workspace.
    if (currentCwd === undefined) return
    const now = Date.now()
    const byKey = new Map<string, AcpSessionHistoryEntry>()
    for (const e of this._state) {
      byKey.set(`${e.agentId} ${e.sessionIdOnAgent}`, e)
    }
    let changed = false
    const reportedSessionIds = new Set<string>()
    for (const info of sessions) {
      if (typeof info.sessionId !== 'string' || info.sessionId.length === 0) continue
      // Defense-in-depth in `workspace` scope: skip cross-workspace entries even
      // if the agent ignored the `cwd` filter on `session/list`. A missing
      // `info.cwd` is tolerated — the agent simply did not report it; existing.cwd
      // wins. In `worktree`/`all` scope we trust the sweep's own scoping and keep
      // every reported session (sibling-worktree / cross-project rows included).
      if (
        scope === 'workspace' &&
        typeof info.cwd === 'string' &&
        !this._uriIdentity.arePathsEqual(info.cwd, currentCwd)
      )
        continue
      reportedSessionIds.add(info.sessionId)
      const key = `${agentId} ${info.sessionId}`
      const existing = byKey.get(key)
      const protocolTs = parseIsoTimestamp(info.updatedAt)
      const reportedTitle =
        typeof info.title === 'string' && info.title.length > 0
          ? info.title
          : (existing?.title ?? info.sessionId)
      // An AI-generated, user-renamed or first-prompt-derived local title wins
      // over the agent's reported `summary`: after `/compact` (or with no
      // session-title model at all) the SDK summary reverts to a prompt, which
      // would otherwise clobber our title here. Once our `renameSession` push
      // lands the agent reports the same value, so this only blocks the
      // divergent (compact-reset / unsupported-agent) case. Unflagged rows get a
      // second line of defence: a summary that is just our first prompt echoed
      // back carries no information the local title doesn't already have.
      const title =
        existing?.manualTitle === true ||
        existing?.aiTitle === true ||
        existing?.derivedTitle === true ||
        (existing !== undefined &&
          existing.firstPrompt !== undefined &&
          isPromptEchoTitle(reportedTitle, [existing.firstPrompt]))
          ? existing.title
          : reportedTitle
      const cwd = typeof info.cwd === 'string' && info.cwd.length > 0 ? info.cwd : existing?.cwd
      const branch =
        typeof info.branch === 'string' && info.branch.length > 0 ? info.branch : existing?.branch
      const transcriptPath =
        typeof info.transcriptPath === 'string' && info.transcriptPath.length > 0
          ? info.transcriptPath
          : existing?.transcriptPath
      if (existing) {
        const lastUsedAt = Math.max(existing.lastUsedAt, protocolTs ?? 0)
        const sameTitle = existing.title === title
        const sameCwd = existing.cwd === cwd || this._uriIdentity.arePathsEqual(existing.cwd, cwd)
        const sameBranch = existing.branch === branch
        const sameTranscriptPath = existing.transcriptPath === transcriptPath
        const sameLastUsed = existing.lastUsedAt === lastUsedAt
        // authority is set once at creation and never overwritten; the only
        // change it accepts is backfilling a legacy row that predates it.
        const backfillAuthority =
          existing.authority === undefined && authority !== undefined ? authority : undefined
        const sameAuthority = backfillAuthority === undefined
        if (
          sameTitle &&
          sameCwd &&
          sameBranch &&
          sameTranscriptPath &&
          sameLastUsed &&
          sameAuthority
        )
          continue
        const next: AcpSessionHistoryEntry = {
          ...existing,
          title,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
          ...(backfillAuthority !== undefined ? { authority: backfillAuthority } : {}),
          lastUsedAt,
        }
        byKey.set(key, next)
        changed = true
      } else {
        const created = protocolTs ?? now
        const next: AcpSessionHistoryEntry = {
          id: info.sessionId,
          agentId,
          sessionIdOnAgent: info.sessionId,
          title,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(authority !== undefined ? { authority } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
          createdAt: created,
          lastUsedAt: created,
        }
        byKey.set(key, next)
        changed = true
      }
    }
    // Replace mode: prune entries for this agent that are absent from the new
    // list and not protected via preserveIds. The prune domain is decided by
    // `pruneDomain` + `scope` (see `replaceAgentEntries`): a sub-root sweep
    // ('sweep' domain) only touches exact-cwd rows; the root sweep keeps its
    // `scope` semantics but never touches strict subdirectories in `worktree`
    // scope — those rows belong to their own sub-root sweeps. Entries with no
    // cwd are always left alone — we cannot tell which workspace they belong to.
    if (preserveIds !== undefined) {
      for (const [key, entry] of byKey) {
        if (entry.agentId !== agentId) continue
        if (entry.cwd === undefined) continue
        if (!this._inPruneDomain(entry.cwd, currentCwd, scope, pruneDomain)) continue
        if (reportedSessionIds.has(entry.sessionIdOnAgent)) continue
        if (preserveIds.has(entry.id)) continue
        byKey.delete(key)
        changed = true
      }
    }
    if (!changed) return
    this._state = Array.from(byKey.values()).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    this._truncate()
    this._publish()
    this._scheduleWrite()
  }

  /**
   * Whether a row with `entryCwd` belongs to the prune domain of a replace
   * sweep (single source of the multi-sweep prune rules — see
   * `replaceAgentEntries`):
   *  - `sweep` domain (sub-root hydrates): exact-`currentCwd` rows only — the
   *    workspace root and sibling sub-roots own the rest.
   *  - `workspace` scope: exact-`currentCwd` rows only (other workspaces survive).
   *  - `worktree` scope: every row EXCEPT strict subdirectories of
   *    `currentCwd` (they belong to their own sub-root sweeps).
   *  - `all` scope: every row (the `all` sweep lists every project).
   */
  private _inPruneDomain(
    entryCwd: string,
    currentCwd: string | undefined,
    scope: SessionHistoryScope,
    pruneDomain: 'scope' | 'sweep',
  ): boolean {
    if (pruneDomain === 'sweep' || scope === 'workspace') {
      return this._uriIdentity.arePathsEqual(entryCwd, currentCwd)
    }
    if (scope === 'worktree') {
      if (
        isDescendantOrEqual(this._uriIdentity, currentCwd, entryCwd) &&
        !this._uriIdentity.arePathsEqual(entryCwd, currentCwd)
      ) {
        return false
      }
    }
    return true
  }

  updateInfo(
    sessionId: string,
    patch: { title?: string; updatedAt?: number },
    opts?: { overwriteProtectedTitle?: boolean },
  ): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const titleProtected =
      cur.aiTitle === true || cur.manualTitle === true || cur.derivedTitle === true
    const nextTitle =
      patch.title !== undefined &&
      patch.title.length > 0 &&
      !(titleProtected && opts?.overwriteProtectedTitle !== true)
        ? patch.title
        : cur.title
    const nextLastUsedAt =
      patch.updatedAt !== undefined && Number.isFinite(patch.updatedAt)
        ? Math.max(cur.lastUsedAt, patch.updatedAt)
        : cur.lastUsedAt
    if (nextTitle === cur.title && nextLastUsedAt === cur.lastUsedAt) return
    const next: AcpSessionHistoryEntry = {
      ...cur,
      title: nextTitle,
      lastUsedAt: nextLastUsedAt,
    }
    this._state = this._state.map((e, i) => (i === idx ? next : e))
    this._state.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    this._publish()
    this._scheduleWrite()
  }

  // -- PersistedStateBase hooks ----------------------------------------

  protected override _emptyState(): AcpSessionHistoryEntry[] {
    return []
  }

  protected override _serialize(state: AcpSessionHistoryEntry[]): PersistedShape {
    return { schemaVersion: SCHEMA_VERSION, entries: state }
  }

  protected override _deserialize(raw: unknown): AcpSessionHistoryEntry[] | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as PersistedShape
    if (!Array.isArray(o.entries)) return undefined
    if (
      o.schemaVersion !== SCHEMA_VERSION &&
      o.schemaVersion !== 4 &&
      o.schemaVersion !== 3 &&
      o.schemaVersion !== 2 &&
      o.schemaVersion !== 1
    ) {
      this._logger.warn(`ignoring acp.sessionHistory with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
    // v1 → v2: `mcpServerNames` is optional, old rows simply inherit the
    // defaults on next resume — no data migration needed.
    // v2 → v3: `plan` is optional, old rows simply have no plan seed on the
    // next resume — no data migration needed.
    // v3 → v4: `aiFix` is optional, old rows are simply non-AI-Fix sessions — no
    // data migration needed.
    // v4 → v5: `derivedTitle` is optional, old rows simply carry no
    // derived-title protection — no data migration needed.
    // schema 约定 id === sessionIdOnAgent；老版本曾用自增 id，这里在反序列化时无损归一化，
    // 否则 history.get(sessionIdOnAgent) 永远 miss。
    return o.entries
      .filter(isValidEntry)
      .map((e) => (e.id === e.sessionIdOnAgent ? e : { ...e, id: e.sessionIdOnAgent }))
  }

  protected override _mergeOnLoad(
    loaded: AcpSessionHistoryEntry[],
    current: AcpSessionHistoryEntry[],
  ): AcpSessionHistoryEntry[] {
    // Any entries the caller already added before load completed win over the
    // persisted row with the same id.
    const seen = new Set(current.map((e) => e.id))
    const merged = [...current]
    for (const e of loaded) {
      if (!seen.has(e.id)) merged.push(e)
    }
    merged.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return this._evictOverflow(merged)
  }

  protected override _onStateReplaced(state: AcpSessionHistoryEntry[]): void {
    this.entries.set(state, undefined)
  }

  // -- private helpers -------------------------------------------------

  private _truncate(): void {
    this._state = this._evictOverflow(this._state)
  }

  /**
   * Bound the state to MAX_ENTRIES, evicting oldest-first but exempting pinned
   * entries — pinning is the user's explicit "do not lose this" marker. If the
   * pinned set alone exceeds MAX_ENTRIES the oldest pinned rows are evicted
   * too (the cap is not grown). Input is expected lastUsedAt-desc; the result
   * keeps that order.
   */
  private _evictOverflow(entries: AcpSessionHistoryEntry[]): AcpSessionHistoryEntry[] {
    if (entries.length <= MAX_ENTRIES) return entries
    const pinned = entries.filter((e) => e.pinned === true)
    const unpinned = entries.filter((e) => e.pinned !== true)
    const kept = [
      ...pinned.slice(0, MAX_ENTRIES),
      ...unpinned.slice(0, Math.max(0, MAX_ENTRIES - pinned.length)),
    ]
    kept.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return kept
  }

  private _publish(): void {
    this.entries.set(this._state, undefined)
  }
}

function isValidEntry(v: unknown): v is AcpSessionHistoryEntry {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'string' &&
    typeof o['agentId'] === 'string' &&
    typeof o['sessionIdOnAgent'] === 'string' &&
    typeof o['title'] === 'string' &&
    (o['cwd'] === undefined || typeof o['cwd'] === 'string') &&
    (o['authority'] === undefined || typeof o['authority'] === 'string') &&
    (o['branch'] === undefined || typeof o['branch'] === 'string') &&
    typeof o['createdAt'] === 'number' &&
    typeof o['lastUsedAt'] === 'number' &&
    (o['configOptions'] === undefined || isStringRecord(o['configOptions'])) &&
    (o['configLabels'] === undefined || isStringRecord(o['configLabels'])) &&
    (o['usage'] === undefined || isValidUsage(o['usage'])) &&
    (o['plan'] === undefined || isValidPlan(o['plan'])) &&
    (o['hasMessages'] === undefined || typeof o['hasMessages'] === 'boolean') &&
    (o['firstPrompt'] === undefined || typeof o['firstPrompt'] === 'string') &&
    (o['aiTitle'] === undefined || typeof o['aiTitle'] === 'boolean') &&
    (o['manualTitle'] === undefined || typeof o['manualTitle'] === 'boolean') &&
    (o['derivedTitle'] === undefined || typeof o['derivedTitle'] === 'boolean') &&
    (o['archived'] === undefined || typeof o['archived'] === 'boolean') &&
    (o['pinned'] === undefined || typeof o['pinned'] === 'boolean') &&
    (o['mcpServerNames'] === undefined || isStringArray(o['mcpServerNames'])) &&
    (o['sideTaskOf'] === undefined || typeof o['sideTaskOf'] === 'string') &&
    (o['sideTaskQuote'] === undefined || typeof o['sideTaskQuote'] === 'string') &&
    (o['sideTaskAnchorMessageId'] === undefined ||
      typeof o['sideTaskAnchorMessageId'] === 'string') &&
    (o['retractedMessageIds'] === undefined || isStringArray(o['retractedMessageIds'])) &&
    (o['aiFix'] === undefined || typeof o['aiFix'] === 'boolean')
  )
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function sameStringArray(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function isValidUsage(v: unknown): v is NonNullable<AcpSessionHistoryEntry['usage']> {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o['used'] !== 'number' || typeof o['size'] !== 'number') return false
  const cost = o['cost']
  if (cost === undefined) return true
  if (typeof cost !== 'object' || cost === null) return false
  const c = cost as Record<string, unknown>
  return typeof c['amount'] === 'number' && typeof c['currency'] === 'string'
}

function sameUsage(
  a: AcpSessionHistoryEntry['usage'],
  b: AcpSessionHistoryEntry['usage'],
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return (
    a.used === b.used &&
    a.size === b.size &&
    a.cost?.amount === b.cost?.amount &&
    a.cost?.currency === b.cost?.currency
  )
}

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function isValidPlan(v: unknown): v is readonly AcpPlanEntry[] {
  if (!Array.isArray(v)) return false
  return v.every((e) => {
    if (typeof e !== 'object' || e === null) return false
    const o = e as Record<string, unknown>
    return (
      typeof o['content'] === 'string' &&
      typeof o['status'] === 'string' &&
      PLAN_STATUSES.has(o['status']) &&
      (o['priority'] === undefined || typeof o['priority'] === 'string')
    )
  })
}

function samePlan(
  a: readonly AcpPlanEntry[] | undefined,
  b: readonly AcpPlanEntry[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every(
    (e, i) =>
      e.content === b[i]!.content && e.status === b[i]!.status && e.priority === b[i]!.priority,
  )
}

function isStringRecord(v: unknown): v is Readonly<Record<string, string>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false
  }
  return true
}

function parseIsoTimestamp(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : undefined
}

registerSingleton(IAcpSessionHistoryService, AcpSessionHistoryService, InstantiationType.Delayed)
