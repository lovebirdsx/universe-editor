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
  IHostService,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  IWorkspaceService,
  InstantiationType,
  arePathsEqual,
  observableValue,
  registerSingleton,
  type HostPlatform,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { PersistedStateBase } from './persistedStateBase.js'
import type { CollapseMode } from './acpChatViewStateCache.js'

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
   * Latest context-window usage snapshot the agent reported via `usage_update`.
   * Mirrored here so the usage arc can be restored on resume — `session/load`
   * replay does not re-emit `usage_update`, so without this snapshot the arc
   * stays blank until the user sends another prompt.
   */
  readonly usage?: {
    readonly used: number
    readonly size: number
    readonly cost?: { readonly amount: number; readonly currency: string }
  }
  /** Timeline collapse mode persisted per-session so it survives editor restarts. */
  readonly collapseMode?: CollapseMode
  /** Cumulative milliseconds the session spent in 'running' status. Updated each time a run segment ends. */
  readonly accumulatedRunningMs?: number
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
   * Patch a single configOption value on a history entry. No-op if id is
   * unknown. Used by `AcpSession.setConfigOption` to mirror user-driven
   * selections so they survive editor restart.
   */
  setHistoryConfigOption(sessionId: string, configId: string, value: string): void
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
   */
  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
  ): void
  /**
   * Replace semantics for a user-initiated refresh: upsert every reported
   * session like `bulkMergeFromAgent`, AND prune any existing entry whose
   * (agentId, cwd) matches but `sessionIdOnAgent` is not in the new list and
   * whose `id` is not in `preserveIds`. `preserveIds` should carry the
   * currently-live session historyIds so a session that hasn't been listed
   * yet (e.g. just-created) does not get pruned from under the UI.
   *
   * Pruning is scoped to entries where `entry.cwd === currentCwd` exactly —
   * entries with a missing `cwd` are left alone (we cannot tell which
   * workspace they belong to). Entries for other agents or other cwds are
   * untouched.
   *
   * Called by the Refresh Session List button via the coordinator.
   */
  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string>,
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

  private readonly _platform: HostPlatform

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IHostService hostService: IHostService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpSessionHistory',
      loggerName: 'ACP History',
      persistFailureEvent: 'acp.session_history_persist_failed',
    })
    this._platform = hostService.platform
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
    // Likewise preserve any prior usage snapshot — re-adding the same session
    // (e.g. on resume) must not blow away the restored arc.
    const carriedUsage =
      entry.usage ?? (existingIdx >= 0 ? this._state[existingIdx]!.usage : undefined)
    const next: AcpSessionHistoryEntry = {
      id,
      agentId: entry.agentId,
      sessionIdOnAgent: entry.sessionIdOnAgent,
      title: entry.title,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      createdAt,
      lastUsedAt: now,
      ...(carriedConfigOptions !== undefined ? { configOptions: carriedConfigOptions } : {}),
      ...(carriedUsage !== undefined ? { usage: carriedUsage } : {}),
      ...(existingIdx >= 0 && this._state[existingIdx]!.collapseMode !== undefined
        ? { collapseMode: this._state[existingIdx]!.collapseMode }
        : {}),
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

  setHistoryConfigOption(sessionId: string, configId: string, value: string): void {
    const idx = this._state.findIndex((e) => e.id === sessionId)
    if (idx === -1) return
    const cur = this._state[idx]!
    const prevOpts = cur.configOptions ?? {}
    if (prevOpts[configId] === value) return
    const nextOpts: Readonly<Record<string, string>> = { ...prevOpts, [configId]: value }
    const next: AcpSessionHistoryEntry = { ...cur, configOptions: nextOpts }
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

  bulkMergeFromAgent(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
  ): void {
    if (sessions.length === 0) return
    this._mergeOrReplace(agentId, sessions, currentCwd, undefined)
  }

  replaceAgentEntries(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string>,
  ): void {
    // Empty bucket protection: same as bulkMergeFromAgent. Without a workspace
    // we don't know which rows to prune, so leave everything alone.
    if (currentCwd === undefined) return
    this._mergeOrReplace(agentId, sessions, currentCwd, preserveIds)
  }

  private _mergeOrReplace(
    agentId: string,
    sessions: readonly BulkMergeSessionInfo[],
    currentCwd: string | undefined,
    preserveIds: ReadonlySet<string> | undefined,
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
      // Defense-in-depth: skip cross-workspace entries even if the agent
      // ignored the `cwd` filter on `session/list`. A missing `info.cwd` is
      // tolerated — the agent simply did not report it; existing.cwd wins.
      if (typeof info.cwd === 'string' && !arePathsEqual(info.cwd, currentCwd, this._platform))
        continue
      reportedSessionIds.add(info.sessionId)
      const key = `${agentId} ${info.sessionId}`
      const existing = byKey.get(key)
      const protocolTs = parseIsoTimestamp(info.updatedAt)
      const title =
        typeof info.title === 'string' && info.title.length > 0
          ? info.title
          : (existing?.title ?? info.sessionId)
      const cwd = typeof info.cwd === 'string' && info.cwd.length > 0 ? info.cwd : existing?.cwd
      if (existing) {
        const lastUsedAt = Math.max(existing.lastUsedAt, protocolTs ?? 0)
        const sameTitle = existing.title === title
        const sameCwd = existing.cwd === cwd || arePathsEqual(existing.cwd, cwd, this._platform)
        const sameLastUsed = existing.lastUsedAt === lastUsedAt
        if (sameTitle && sameCwd && sameLastUsed) continue
        const next: AcpSessionHistoryEntry = {
          ...existing,
          title,
          ...(cwd !== undefined ? { cwd } : {}),
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
          createdAt: created,
          lastUsedAt: created,
        }
        byKey.set(key, next)
        changed = true
      }
    }
    // Replace mode: prune any entry that matches (agentId, cwd === currentCwd)
    // but is absent from the new sessions list and not protected via preserveIds.
    // Entries with no cwd are left alone — we cannot tell which workspace they
    // belong to.
    if (preserveIds !== undefined) {
      for (const [key, entry] of byKey) {
        if (entry.agentId !== agentId) continue
        if (!arePathsEqual(entry.cwd, currentCwd, this._platform)) continue
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
    typeof o['createdAt'] === 'number' &&
    typeof o['lastUsedAt'] === 'number' &&
    (o['configOptions'] === undefined || isStringRecord(o['configOptions'])) &&
    (o['usage'] === undefined || isValidUsage(o['usage']))
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
