/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListBody — the pure list rendering reused by SessionListPanel (full
 *  sidebar view) and SessionsPopover (Copilot-style dropdown). Click behavior
 *  flips the active session (resuming if necessary); in editor mode the tab is
 *  opened by AcpChatLocationService's activeSession autorun — keeping a single
 *  source of truth for "which input is open" avoids races that produced
 *  duplicate tabs. The optional `onPick` callback fires afterwards so popovers
 *  can collapse themselves.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  localize,
  IDialogService,
  IConfigurationService,
  ConfigurationTarget,
  IWorkspaceService,
  IEditorService,
  IInstantiationService,
  IUriIdentityService,
  ICommandService,
} from '@universe-editor/platform'
import {
  X,
  Trash2,
  GitBranch,
  Pencil,
  Archive,
  ArchiveRestore,
  Pin,
  PinOff,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import {
  IconButton,
  Input,
  fuzzyMatchField,
  scoreFuzzyMatch,
  useScrollRestore,
} from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { relativeTime } from '../../relativeTime.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type SessionHistoryScope,
} from '../../services/acp/session/acpSessionHistory.js'
import { IAcpSessionFilterService } from '../../services/acp/session/acpSessionFilterService.js'
import { statusBucketFor } from '../../services/acp/session/acpSessionFilterService.js'
import { computeSessionDisplayStatus } from '../../services/acp/session/acpSessionStatus.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { AgentIcon } from './agentIcon.js'
import {
  SessionRowContextMenu,
  type SessionRowContextMenuState,
  type SessionRowMenuItem,
} from './SessionRowContextMenu.js'
import { useSessionTimer, formatRunningTime } from './useSessionTimer.js'
import { formatCny } from './SessionCostIndicator.js'
import { findLabel } from './ConfigOptionsBar.js'
import { useUsdToCnyRate } from './useExchangeRate.js'
import { useForeignSessionStats, type ForeignSessionStat } from './useForeignSessionStats.js'
import styles from './agents.module.css'

function scoreSession(entry: AcpSessionHistoryEntry, query: string): number {
  const titleScore = scoreFuzzyMatch(entry.title, query)
  if (titleScore >= 0) return 10_000 + titleScore
  return fuzzyMatchField(entry.agentId, query) ? 0 : -1
}

function filterSessions(
  entries: readonly AcpSessionHistoryEntry[],
  query: string,
): readonly AcpSessionHistoryEntry[] {
  const q = query.trim()
  if (!q) return entries
  return entries
    .map((entry, index) => ({ entry, index, score: scoreSession(entry, q) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.entry)
}

const FALLBACK_RATE = 7.2

const HISTORY_SCOPE_KEY = 'acp.sessions.historyScope'

function readHistoryScope(config: IConfigurationService): SessionHistoryScope {
  const raw = config.get<string>(HISTORY_SCOPE_KEY)
  return raw === 'workspace' || raw === 'worktree' || raw === 'all' ? raw : 'worktree'
}

/** Last path segment of an absolute fs path, for a compact directory fallback label. */
function pathTail(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : p
}

/**
 * What to show in the per-row scope chip and its full-path tooltip:
 *  - `all`:      the session cwd.
 *  - `worktree`: the git branch, falling back to the cwd's last segment.
 *  - `workspace`: nothing (the list is already a single workspace).
 */
function scopeChip(
  entry: AcpSessionHistoryEntry,
  scope: SessionHistoryScope,
): { label: string; title: string } | undefined {
  if (scope === 'all') {
    if (!entry.cwd) return undefined
    return { label: entry.cwd, title: entry.cwd }
  }
  if (scope === 'worktree') {
    if (entry.cwd)
      return {
        label: pathTail(entry.cwd),
        title: entry.branch ? `${entry.cwd} [${entry.branch}]` : entry.cwd,
      }
    if (entry.branch) return { label: entry.branch, title: entry.branch }
  }
  return undefined
}

function LiveSessionTimer({ session }: { session: IAcpSession }) {
  const ms = useSessionTimer(session)
  if (ms === 0) return null
  return <span className={styles['sessionRowTimer']}>{formatRunningTime(ms)}</span>
}

/**
 * Self-subscribed status glyph for a live row: a spinner while the background
 * handshake is in flight, an error badge when it failed. The row list itself
 * does not re-render on status flips (the sessions array identity is stable
 * across attach/fail), so the subscription must live here.
 */
function LiveSessionStatus({ session }: { session: IAcpSession }) {
  const status = useObservable(session.status)
  if (status === 'connecting') {
    return (
      <Loader2
        size={13}
        strokeWidth={1.75}
        className={styles['spin']}
        data-status="connecting"
        aria-label={localize('acp.sessions.connecting', 'Connecting…')}
      />
    )
  }
  if (status === 'errored') {
    return (
      <AlertCircle
        size={13}
        strokeWidth={1.75}
        className={styles['sessionRowError']}
        data-status="errored"
        aria-label={localize('acp.sessions.startFailed', 'Failed to start')}
      />
    )
  }
  return null
}

function LiveSessionCost({ session, rate }: { session: IAcpSession; rate: number }) {
  const usage = useObservable(session.usage)
  const totalUsd = usage?.cost?.amount
  if (usage == null || totalUsd == null || totalUsd <= 0) return null
  const estimated = usage.costEstimated === true
  return (
    <span className={styles['sessionRowCost']}>
      {estimated ? '≈' : ''}¥{formatCny(totalUsd * rate)}
    </span>
  )
}

function LiveSessionModel({ session }: { session: IAcpSession }) {
  const configOptions = useObservable(session.configOptions)
  const modelOption = configOptions.find((o) => o.category === 'model')
  if (!modelOption) return null
  const label =
    modelOption.type === 'select'
      ? findLabel(modelOption.options, modelOption.currentValue)
      : modelOption.currentValue
  if (!label) return null
  return <span className={styles['sessionRowModel']}>{label}</span>
}

function LiveSessionEffort({ session }: { session: IAcpSession }) {
  const configOptions = useObservable(session.configOptions)
  const effortOption = configOptions.find((o) => o.category === 'thought_level')
  if (!effortOption) return null
  const label =
    effortOption.type === 'select'
      ? findLabel(effortOption.options, effortOption.currentValue)
      : effortOption.currentValue
  if (!label) return null
  return <span className={styles['sessionRowEffort']}>{label}</span>
}

function formatModelId(id: string): string {
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export interface SessionListBodyProps {
  /** Suppress the inline "no sessions" line — popovers render their own. */
  hideEmptyState?: boolean
  /**
   * Stable key identifying the hosting view; when set, the row list's scroll
   * position is saved on unmount and restored on remount through
   * ScrollStateCache (survives sidebar container switches, not a window reload).
   * The popover variant omits it — it re-mounts fresh on every open.
   */
  scrollStateKey?: string
  /**
   * Called after a row is picked. Popover variant uses this to dismiss itself.
   * The list still drives session activation + editor open; this hook is
   * fire-and-forget.
   */
  onPick?: (entry: AcpSessionHistoryEntry) => void
}

function SessionRow({
  entry,
  liveSession,
  isActive,
  isPending,
  onActivate,
  onRemove,
  onRename,
  onToggleArchive,
  onTogglePin,
  onContextMenu,
  rate,
  scope,
  isForeign,
  foreignStat,
}: {
  entry: AcpSessionHistoryEntry
  liveSession: IAcpSession | undefined
  isActive: boolean
  /** True for the optimistic row of a session still in its background handshake. */
  isPending: boolean
  onActivate: () => void
  onRemove: () => void
  onRename: (() => void) | undefined
  onToggleArchive: () => void
  onTogglePin: () => void
  onContextMenu: (e: ReactMouseEvent) => void
  rate: number
  scope: SessionHistoryScope
  isForeign: boolean
  foreignStat: ForeignSessionStat | undefined
}) {
  const isRunning = liveSession !== undefined
  // Foreign rows are rebuilt by the hydrate sweep without duration/cost; fall
  // back to the values read from the owning worktree's own storage bucket.
  const historyMs = entry.accumulatedRunningMs ?? foreignStat?.accumulatedRunningMs ?? 0
  const historyUsage = entry.usage ?? foreignStat?.usage
  const historyCostUsd = historyUsage?.cost?.amount
  const historyCostEstimated = historyUsage?.costEstimated === true
  // Foreign rows carry no configOptions on the rebuilt entry — fall back to the
  // owning worktree bucket (foreignStat) the same way duration/cost do.
  const historyConfigOptions = entry.configOptions ?? foreignStat?.configOptions
  const historyConfigLabels = entry.configLabels ?? foreignStat?.configLabels
  // Prefer the persisted friendly label; fall back to the raw value (model is
  // shortened, effort is shown verbatim). Config ids match the ACP protocol:
  // `model` (Claude + Codex), `reasoning_effort` (Codex) / `effort` (Claude).
  const historyModelLabel =
    historyConfigLabels?.['model'] ??
    ((historyConfigOptions?.['model'] ?? historyUsage?.models?.[0]?.model)
      ? formatModelId((historyConfigOptions?.['model'] ?? historyUsage?.models?.[0]?.model)!)
      : undefined)
  const historyEffortLabel =
    historyConfigLabels?.['reasoning_effort'] ??
    historyConfigLabels?.['effort'] ??
    historyConfigOptions?.['reasoning_effort'] ??
    historyConfigOptions?.['effort']
  const chip = scopeChip(entry, scope)
  const isArchived = entry.archived === true
  const isPinned = entry.pinned === true
  // Hover tooltip: the full first user prompt when it was recorded (new rows),
  // otherwise the row's display title. The recorded firstPrompt survives an
  // AI/manual rename, which is exactly when the tooltip is most useful.
  const rowTooltip =
    entry.firstPrompt ?? foreignStat?.firstPrompt ?? foreignStat?.title ?? entry.title
  const archiveLabel = isArchived
    ? localize('acp.sessions.unarchive', 'Unarchive session (Shift+Del)')
    : localize('acp.sessions.archive', 'Archive session (Del)')
  const pinLabel = isPinned
    ? localize('acp.sessions.unpin', 'Unpin session')
    : localize('acp.sessions.pin', 'Pin session')
  return (
    <li
      className={styles['sessionRow']}
      data-active={isActive ? 'true' : 'false'}
      data-running={isRunning ? 'true' : 'false'}
      data-foreign={isForeign ? 'true' : 'false'}
      data-archived={isArchived ? 'true' : 'false'}
      data-pending={isPending ? 'true' : 'false'}
      data-testid={`session-row-${entry.id}`}
      data-tooltip={rowTooltip}
      tabIndex={0}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        // Del archives an unarchived row; Shift+Del restores an archived one
        // (mirrors VSCode's agentSessions viewer keys). Other combinations are
        // no-ops so a stray Shift+Del can't archive and vice versa.
        if (e.key === 'Delete' && e.shiftKey === isArchived) {
          e.preventDefault()
          e.stopPropagation()
          onToggleArchive()
        }
      }}
    >
      <div className={styles['sessionRowTitle']}>
        <span className={styles['sessionRowLabelLine']}>
          <AgentIcon agentId={entry.agentId} size={14} className={styles['sessionRowAgentIcon']} />
          <span className={styles['sessionRowLabel']}>{foreignStat?.title ?? entry.title}</span>
          {isPinned ? (
            <Pin
              size={12}
              strokeWidth={1.75}
              className={styles['sessionRowPin']}
              aria-label={localize('acp.sessions.pinned', 'Pinned')}
            />
          ) : null}
        </span>
        <span className={styles['sessionRowMeta']}>
          {liveSession !== undefined ? <LiveSessionStatus session={liveSession} /> : null}
          {relativeTime(entry.lastUsedAt)}
          {liveSession !== undefined ? (
            <LiveSessionModel session={liveSession} />
          ) : historyModelLabel ? (
            <span className={styles['sessionRowModel']}>{historyModelLabel}</span>
          ) : null}
          {liveSession !== undefined ? (
            <LiveSessionEffort session={liveSession} />
          ) : historyEffortLabel ? (
            <span className={styles['sessionRowEffort']}>{historyEffortLabel}</span>
          ) : null}
          {liveSession !== undefined ? (
            <LiveSessionTimer session={liveSession} />
          ) : historyMs > 0 ? (
            <span className={styles['sessionRowTimer']}>{formatRunningTime(historyMs)}</span>
          ) : null}
          {liveSession !== undefined ? (
            <LiveSessionCost session={liveSession} rate={rate} />
          ) : historyCostUsd != null && historyCostUsd > 0 ? (
            <span className={styles['sessionRowCost']}>
              {historyCostEstimated ? '≈' : ''}¥{formatCny(historyCostUsd * rate)}
            </span>
          ) : null}
          {chip ? (
            <span className={styles['sessionRowScopeGroup']} data-tooltip={chip.title}>
              {isForeign ? (
                <GitBranch
                  size={12}
                  strokeWidth={1.75}
                  className={styles['sessionRowForeignIcon']}
                  aria-label={localize(
                    'acp.sessions.foreignWorktree',
                    'Belongs to another worktree',
                  )}
                />
              ) : null}
              <span className={styles['sessionRowScope']}>{'‎' + chip.label}</span>
            </span>
          ) : null}
        </span>
      </div>
      {/* Archive/Pin/Rename are history-row flags — meaningless on the
          optimistic pending row (nothing persisted yet), so hidden there. */}
      {!isPending ? (
        <button
          type="button"
          className={styles['sessionArchive']}
          onClick={(e) => {
            e.stopPropagation()
            onToggleArchive()
          }}
          aria-label={archiveLabel}
          data-tooltip={archiveLabel}
        >
          {isArchived ? (
            <ArchiveRestore size={13} strokeWidth={1.75} />
          ) : (
            <Archive size={13} strokeWidth={1.75} />
          )}
        </button>
      ) : null}
      {!isPending ? (
        <button
          type="button"
          className={styles['sessionPin']}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          aria-label={pinLabel}
          data-tooltip={pinLabel}
        >
          {isPinned ? (
            <PinOff size={13} strokeWidth={1.75} />
          ) : (
            <Pin size={13} strokeWidth={1.75} />
          )}
        </button>
      ) : null}
      {onRename && !isPending ? (
        <button
          type="button"
          className={styles['sessionRename']}
          onClick={(e) => {
            e.stopPropagation()
            onRename()
          }}
          aria-label={localize('acp.sessions.rename', 'Rename session')}
        >
          <Pencil size={13} strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles['sessionDelete']}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={localize('acp.sessions.remove', 'Remove session')}
      >
        <Trash2 size={13} strokeWidth={1.75} />
      </button>
    </li>
  )
}

export function SessionListBody({ hideEmptyState, scrollStateKey, onPick }: SessionListBodyProps) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const filterService = useService(IAcpSessionFilterService)
  const config = useService(IConfigurationService)
  const workspace = useService(IWorkspaceService)
  const uriIdentity = useService(IUriIdentityService)
  const dialogService = useService(IDialogService)
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const commandService = useService(ICommandService)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders; the value also
  // feeds the optimistic pending rows below.
  const sessions = useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)

  const [menu, setMenu] = useState<SessionRowContextMenuState | null>(null)

  const searchOpen = useObservable(filterService.searchOpen)
  const query = useObservable(filterService.query)
  const sortMode = useObservable(filterService.sortMode)
  const excludedAgents = useObservable(filterService.excludedAgentIds)
  const excludedStatuses = useObservable(filterService.excludedStatuses)
  const showArchived = useObservable(filterService.showArchived)

  // The config service exposes an Event, not an observable — mirror the scope
  // into local state so the list re-renders (and re-filters) when it changes.
  const [scope, setScope] = useState<SessionHistoryScope>(() => readHistoryScope(config))
  useEffect(() => {
    const d = config.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(HISTORY_SCOPE_KEY)) setScope(readHistoryScope(config))
    })
    return () => d.dispose()
  }, [config])

  // 本机路径，不随远端工作区变化：agent 在本机 spawn，cwd 为本机路径。
  const currentCwd = workspace.current?.folder.fsPath

  const scrollRef = useRef<HTMLUListElement | null>(null)
  useScrollRestore(
    scrollStateKey,
    useCallback(() => scrollRef.current, []),
  )

  // Optimistic rows for sessions still in their background handshake. The
  // durable history row is keyed by the agent-issued sessionIdOnAgent, which
  // only exists after session/new returns — so without these the freshly
  // created session is invisible here for the whole handshake (codex: 10s+).
  // Guards: not closed, not a read-only foreign preview, no agent id yet (an
  // attached session already has its history row), and no history row under
  // the local id (a resume-in-progress shares the durable id with its row).
  // The handshake lands `_history.add` and `attachConnection` in one sync
  // block, so by the next render guard 3 has dropped the pending row exactly
  // as the history row appears — they never coexist, never both vanish.
  const pendingEntries = useMemo(() => {
    const now = Date.now()
    const pending: AcpSessionHistoryEntry[] = []
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]!
      if (s.status.get() === 'closed') continue
      if (s.readOnly) continue
      if (s.sessionIdOnAgent.get() !== undefined) continue
      // A resume-in-progress shares the durable id with its history row.
      if (entries.some((e) => e.id === s.id)) continue
      pending.push({
        id: s.id,
        agentId: s.agentId,
        sessionIdOnAgent: '',
        title: s.title,
        ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
        createdAt: now,
        lastUsedAt: now,
      })
    }
    return pending
  }, [sessions, entries, currentCwd])

  const pendingIds = useMemo(() => new Set(pendingEntries.map((e) => e.id)), [pendingEntries])

  const merged = useMemo(
    () => (pendingEntries.length > 0 ? [...pendingEntries, ...entries] : entries),
    [pendingEntries, entries],
  )

  // In `workspace` scope keep only exact-cwd rows so narrowing applies instantly
  // without waiting for the next replace-mode hydrate. `worktree`/`all` trust the
  // hydrate sweep's scoping (which already bounds what the bucket contains).
  const scoped = useMemo(() => {
    if (scope !== 'workspace' || currentCwd === undefined) return merged
    return merged.filter((e) => e.cwd === undefined || uriIdentity.arePathsEqual(e.cwd, currentCwd))
  }, [merged, scope, currentCwd, uriIdentity])

  const filtered = useMemo(() => filterSessions(scoped, query), [scoped, query])

  // Apply the archived-visibility gate, the funnel-menu filters (agent +
  // status) and the chosen sort. Status is derived from the live session when
  // one exists; a non-live history row has no live status and counts as
  // `completed`. Archived rows are hidden unless the filter popover's
  // "Archived" toggle is on. When a search query is active the fuzzy-score
  // order from `filterSessions` wins over everything — pinned rows must not
  // outrank a better match. Otherwise rows sort into three bands: pinned
  // first, plain rows next, archived last; each band keeps the sortMode order.
  const visible = useMemo(() => {
    const archKept = showArchived ? filtered : filtered.filter((e) => e.archived !== true)
    const kept = archKept.filter((entry) => {
      // Side tasks belong to their parent session (child rows) and are reached
      // through the parent chat's side-tasks popover — never listed here, not
      // even under the Archived toggle.
      if (entry.sideTaskOf !== undefined) return false
      if (excludedAgents.has(entry.agentId)) return false
      if (excludedStatuses.size > 0) {
        const live = service.getById(entry.id)
        const bucket =
          live && !live.readOnly ? statusBucketFor(computeSessionDisplayStatus(live)) : 'completed'
        if (excludedStatuses.has(bucket)) return false
      }
      return true
    })
    if (query.trim().length > 0) return kept
    // Pending rows rank above everything (band -1) — a just-created session
    // belongs at the top. Once attached, its history row sorts by lastUsedAt
    // and lands in the same top position, so the swap is position-continuous.
    const rank = (e: AcpSessionHistoryEntry) =>
      pendingIds.has(e.id) ? -1 : e.archived === true ? 2 : e.pinned === true ? 0 : 1
    const sorted = [...kept]
    sorted.sort((a, b) => {
      const band = rank(a) - rank(b)
      if (band !== 0) return band
      return sortMode === 'created' ? b.createdAt - a.createdAt : b.lastUsedAt - a.lastUsedAt
    })
    return sorted
  }, [
    filtered,
    showArchived,
    excludedAgents,
    excludedStatuses,
    sortMode,
    query,
    service,
    pendingIds,
  ])

  const exchangeRate = useUsdToCnyRate()
  const rate = exchangeRate?.rate ?? FALLBACK_RATE

  // Foreign (other-worktree) rows lose their duration/cost in the hydrate merge;
  // backfill them from each owning worktree's own storage bucket.
  const foreignStats = useForeignSessionStats(visible, currentCwd)

  // Reconcile authoritative foreign titles back into this bucket. A foreign
  // session's title in the current bucket is only a hydrate cache; if the owning
  // workspace set an AI title after our once-per-cwd hydrate ran (or the session
  // JSONL was deleted so `session/list` can no longer report it), that cache is
  // stuck on the first user message. `useForeignSessionStats` reads the real
  // title from the owning bucket; write it back (title-only — never flag
  // `aiTitle`, so a later hydrate can still update it) so the tab label + window
  // title, which read `history.entries`, self-heal too.
  useEffect(() => {
    for (const e of entries) {
      const authoritative = foreignStats.get(e.id)?.title
      if (authoritative !== undefined && authoritative !== e.title) {
        history.updateInfo(e.id, { title: authoritative })
      }
    }
  }, [entries, foreignStats, history])

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      filterService.closeSearch()
    }
  }

  if (merged.length === 0) {
    if (hideEmptyState) return null
    return <p className={styles['empty']}>{localize('acp.sessions.empty', 'No sessions yet.')}</p>
  }

  return (
    <div className={styles['sessionListBody']}>
      {searchOpen ? (
        <div className={styles['sessionFindWidget']} role="search">
          <Input
            autoFocus
            value={query}
            onChange={(e) => filterService.setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={localize('acp.sessions.search', 'Search sessions')}
            className={styles['sessionFindInput']}
            data-testid="acp-session-search-input"
          />
          <IconButton
            label={localize('acp.sessions.searchClose', 'Close search')}
            onClick={() => filterService.closeSearch()}
          >
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className={styles['empty']}>
          {localize('acp.sessions.noMatch', 'No matching sessions.')}
        </p>
      ) : (
        <ul className={styles['sessionRows']} ref={scrollRef}>
          {visible.map((entry) => {
            const isPending = pendingIds.has(entry.id)
            const live = service.getById(entry.id)
            // A read-only foreign preview is a live AcpSession instance but must
            // not light up the running indicator / timer / "active" styling — it
            // is a viewer, not the working session.
            const liveSession =
              live && live.status.get() !== 'closed' && !live.readOnly ? live : undefined
            const isActive = liveSession !== undefined && liveSession.id === activeId
            const isForeign =
              entry.cwd !== undefined &&
              currentCwd !== undefined &&
              !uriIdentity.arePathsEqual(entry.cwd, currentCwd)
            const onRename =
              isForeign || isPending
                ? undefined
                : () => {
                    void commandService.executeCommand('workbench.action.agent.renameSession', {
                      sessionId: entry.id,
                    })
                  }
            const onReveal = () => {
              void commandService.executeCommand('workbench.action.agent.revealSessionInOS', {
                sessionId: entry.id,
              })
            }
            const onToggleArchive = isPending
              ? () => {}
              : () => {
                  void commandService.executeCommand(
                    entry.archived === true
                      ? 'workbench.action.agent.unarchiveSession'
                      : 'workbench.action.agent.archiveSession',
                    { sessionId: entry.id },
                  )
                }
            const onTogglePin = isPending
              ? () => {}
              : () => {
                  void commandService.executeCommand(
                    entry.pinned === true
                      ? 'workbench.action.agent.unpinSession'
                      : 'workbench.action.agent.pinSession',
                    { sessionId: entry.id },
                  )
                }
            const onRemove = () => {
              void (async () => {
                if (config.get<boolean>('acp.sessions.confirmDelete') !== false) {
                  const result = await dialogService.confirm({
                    message: localize('acp.sessions.removeConfirm', 'Delete this session?'),
                    detail: localize(
                      'acp.sessions.removeConfirmDetail',
                      'This will delete the session and its history.',
                    ),
                    primaryButton: localize('acp.sessions.removeConfirmOk', 'Delete'),
                    cancelButton: localize('acp.sessions.removeConfirmCancel', 'Cancel'),
                    neverAskAgainLabel: localize('acp.sessions.removeNeverAsk', "Don't ask again"),
                  })
                  if (!result.confirmed) return
                  if (result.neverAskAgain) {
                    config.update('acp.sessions.confirmDelete', false, ConfigurationTarget.User)
                  }
                }
                if (liveSession) await service.closeSession(liveSession.id)
                // A pending row has no agent-side session yet (session/new may
                // still be in flight) and no history row — closing the live
                // session is the whole delete.
                if (isPending) return
                await service.deleteOnAgent(entry.id)
                history.remove(entry.id)
              })()
            }
            // A live session has no transcriptPath on its history row until the
            // next hydrate sweep, but the reveal action resolves it on demand —
            // so only a history-only row without a path stays disabled.
            const hasTranscript =
              liveSession !== undefined ||
              (entry.transcriptPath !== undefined &&
                entry.transcriptPath !== null &&
                entry.transcriptPath.length > 0)
            const openContextMenu = (e: ReactMouseEvent) => {
              e.preventDefault()
              e.stopPropagation()
              const items: SessionRowMenuItem[] = []
              if (!isPending) {
                items.push({
                  kind: 'item',
                  label:
                    entry.pinned === true
                      ? localize('acp.sessions.unpinMenu', 'Unpin Session')
                      : localize('acp.sessions.pinMenu', 'Pin Session'),
                  run: onTogglePin,
                })
                items.push({
                  kind: 'item',
                  label:
                    entry.archived === true
                      ? localize('acp.sessions.unarchiveMenu', 'Unarchive Session')
                      : localize('acp.sessions.archiveMenu', 'Archive Session'),
                  run: onToggleArchive,
                })
                if (onRename) {
                  items.push({
                    kind: 'item',
                    label: localize('acp.sessions.renameMenu', 'Rename Session'),
                    run: onRename,
                  })
                }
                items.push({
                  kind: 'item',
                  label: localize('acp.sessions.revealTranscript', 'Open Session Location'),
                  disabled: !hasTranscript,
                  run: onReveal,
                })
                items.push({ kind: 'separator' })
              }
              items.push({
                kind: 'item',
                label: localize('acp.sessions.removeMenu', 'Delete Session'),
                danger: true,
                run: onRemove,
              })
              setMenu({ x: e.clientX, y: e.clientY, sessionId: entry.id, items })
            }
            return (
              <SessionRow
                key={entry.id}
                entry={entry}
                liveSession={liveSession}
                isActive={isActive}
                isPending={isPending}
                rate={rate}
                scope={scope}
                isForeign={isForeign}
                foreignStat={foreignStats.get(entry.id)}
                onRename={onRename}
                onToggleArchive={onToggleArchive}
                onTogglePin={onTogglePin}
                onContextMenu={openContextMenu}
                onActivate={() => {
                  const fresh = service.getById(entry.id)
                  // Exclude read-only previews: a live read-only session must not
                  // be set active; clicking re-opens its (read-only) tab via the
                  // foreign branch below.
                  const liveNow =
                    fresh && fresh.status.get() !== 'closed' && !fresh.readOnly ? fresh : undefined
                  if (liveNow) {
                    service.setActive(liveNow.id)
                  } else if (
                    entry.cwd !== undefined &&
                    currentCwd !== undefined &&
                    !uriIdentity.arePathsEqual(entry.cwd, currentCwd)
                  ) {
                    // Foreign worktree: don't resume (would spawn the agent
                    // against another worktree behind this window's UI). Open a
                    // read-only preview tab; the user activates from there.
                    editorService.openEditor(
                      instantiation.createInstance(
                        AcpSessionEditorInput,
                        entry.id,
                        entry.agentId,
                        entry.title,
                      ),
                    )
                  } else {
                    service.resumeSession(entry.id).catch(() => {
                      // resumeSession publishes its own notification.
                    })
                  }
                  onPick?.(entry)
                }}
                onRemove={onRemove}
              />
            )
          })}
        </ul>
      )}
      {menu ? <SessionRowContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}
