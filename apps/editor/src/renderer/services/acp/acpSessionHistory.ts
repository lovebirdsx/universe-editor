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
import { PersistedStateBase } from './persistedStateBase.js'
import type { CollapseMode } from './acpChatViewStateCache.js'

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
   * Git branch reported by the agent for this session (end-of-session branch).
   * Used to label rows when the history scope spans worktrees. Optional — not
   * all agents report it and non-git sessions have none.
   */
  readonly branch?: string
  /**
   * Absolute path to the session's transcript file (claude: the `.jsonl` under
   * `~/.claude/projects/<encoded-cwd>/`), reported by the agent via
   * `SessionInfo._meta.transcriptPath`. Optional — codex and other agents that
   * have no per-session transcript file omit it. Used by the "Reveal Session
   * Location" command to show the file in the OS file manager.
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
      readonly costUSD: number
    }>
    /** True when cost/models are locally estimated (Codex) rather than agent-reported. */
    readonly costEstimated?: boolean
  }
  /** Timeline collapse mode persisted per-session so it survives editor restarts. */
  readonly collapseMode?: CollapseMode
  /** Cumulative milliseconds the session spent in 'running' status. Updated each time a run segment ends. */
  readonly accumulatedRunningMs?: number
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
   * `scope` controls how strict the cwd filter is: `workspace` keeps only
   * exact-cwd rows; `worktree`/`all` trust the sweep's own scoping and accept
   * every reported session (so sibling-worktree / cross-project rows survive).
   */
  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
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
   * Pruning follows `scope`: in `workspace` scope only exact-`currentCwd` rows
   * are eligible (other workspaces survive); in `worktree`/`all` scope any
   * known-cwd row for this agent is eligible, so narrowing the scope drops the
   * rows a wider scope had pulled in. Entries with a missing `cwd` are always
   * left alone (we cannot tell which workspace they belong to). Entries for
   * other agents are untouched.
   *
   * Called by the Refresh Session List button via the coordinator.
   */
  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string>,
    scope: SessionHistoryScope,
  ): void
  /**
   * Patch metadata for one entry from a `session_info_update` notification.
   * No-op if id is unknown.
   */
  updateInfo(sessionId: string, patch: { title?: string; updatedAt?: number }): void
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

export const IAcpSessionHistoryService = createDecorator<IAcpSessionHistoryService>(
  'acpSessionHistoryService',
)

const STORAGE_KEY = 'acp.sessionHistory'
const SCHEMA_VERSION = 1
const MAX_ENTRIES = 100

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
    // Once hasMessages is true it must never revert. Input value takes
    // precedence; fall back to the existing row so resume() preserves it.
    const carriedHasMessages = (() => {
      const existing = existingIdx >= 0 ? this._state[existingIdx]!.hasMessages : undefined
      if (existing === true) return true
      return entry.hasMessages
    })()
    // Preserve a prior AI-title / manual-title flag + its title across re-add
    // (the construct-time `entry.title` is the default placeholder, not the
    // user-chosen / AI title). Manual title ranks above AI title.
    const existingAiTitle = existingIdx >= 0 ? this._state[existingIdx]!.aiTitle : undefined
    const existingManualTitle = existingIdx >= 0 ? this._state[existingIdx]!.manualTitle : undefined
    const title =
      existingManualTitle === true || existingAiTitle === true
        ? this._state[existingIdx]!.title
        : entry.title
    const next: AcpSessionHistoryEntry = {
      id,
      agentId: entry.agentId,
      sessionIdOnAgent: entry.sessionIdOnAgent,
      title,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      createdAt,
      lastUsedAt: now,
      ...(carriedConfigOptions !== undefined ? { configOptions: carriedConfigOptions } : {}),
      ...(carriedConfigLabels !== undefined ? { configLabels: carriedConfigLabels } : {}),
      ...(carriedUsage !== undefined ? { usage: carriedUsage } : {}),
      ...(existingIdx >= 0 && this._state[existingIdx]!.collapseMode !== undefined
        ? { collapseMode: this._state[existingIdx]!.collapseMode }
        : {}),
      ...(carriedHasMessages !== undefined ? { hasMessages: carriedHasMessages } : {}),
      ...(existingAiTitle === true ? { aiTitle: true } : {}),
      ...(existingManualTitle === true ? { manualTitle: true } : {}),
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

  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    scope: SessionHistoryScope,
  ): void {
    if (sessions.length === 0) return
    this._mergeOrReplace(agentId, sessions, currentCwd, undefined, scope)
  }

  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string>,
    scope: SessionHistoryScope,
  ): void {
    // Empty bucket protection: same as bulkMergeFromAgent. Without a workspace
    // we don't know which rows to prune, so leave everything alone.
    if (currentCwd === undefined) return
    this._mergeOrReplace(agentId, sessions, currentCwd, preserveIds, scope)
  }

  private _mergeOrReplace(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string> | undefined,
    scope: SessionHistoryScope,
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
      // An AI-generated or user-renamed local title wins over the agent's
      // reported `summary`: after `/compact` the SDK summary reverts to the
      // first prompt, which would otherwise clobber our title here. Once our
      // `renameSession` push lands the agent reports the same value, so this
      // only blocks the divergent (compact-reset / unsupported-agent) case.
      const title =
        existing?.manualTitle === true || existing?.aiTitle === true
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
        if (sameTitle && sameCwd && sameBranch && sameTranscriptPath && sameLastUsed) continue
        const next: AcpSessionHistoryEntry = {
          ...existing,
          title,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
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
    // list and not protected via preserveIds. The prune domain follows `scope`:
    // `workspace` only touches exact-cwd rows (so unrelated workspaces survive);
    // `worktree`/`all` prune any known-cwd row (so narrowing the scope or losing
    // a sibling worktree drops it). Entries with no cwd are always left alone —
    // we cannot tell which workspace they belong to.
    if (preserveIds !== undefined) {
      for (const [key, entry] of byKey) {
        if (entry.agentId !== agentId) continue
        if (entry.cwd === undefined) continue
        if (scope === 'workspace' && !this._uriIdentity.arePathsEqual(entry.cwd, currentCwd))
          continue
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

  updateInfo(sessionId: string, patch: { title?: string; updatedAt?: number }): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const nextTitle = patch.title !== undefined && patch.title.length > 0 ? patch.title : cur.title
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
    if (o.schemaVersion !== SCHEMA_VERSION) {
      this._logger.warn(`ignoring acp.sessionHistory with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
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
    if (merged.length > MAX_ENTRIES) merged.length = MAX_ENTRIES
    return merged
  }

  protected override _onStateReplaced(state: AcpSessionHistoryEntry[]): void {
    this.entries.set(state, undefined)
  }

  // -- private helpers -------------------------------------------------

  private _truncate(): void {
    if (this._state.length > MAX_ENTRIES) {
      this._state = this._state.slice(0, MAX_ENTRIES)
    }
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
    (o['branch'] === undefined || typeof o['branch'] === 'string') &&
    typeof o['createdAt'] === 'number' &&
    typeof o['lastUsedAt'] === 'number' &&
    (o['configOptions'] === undefined || isStringRecord(o['configOptions'])) &&
    (o['configLabels'] === undefined || isStringRecord(o['configLabels'])) &&
    (o['usage'] === undefined || isValidUsage(o['usage'])) &&
    (o['hasMessages'] === undefined || typeof o['hasMessages'] === 'boolean') &&
    (o['aiTitle'] === undefined || typeof o['aiTitle'] === 'boolean') &&
    (o['manualTitle'] === undefined || typeof o['manualTitle'] === 'boolean')
  )
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
