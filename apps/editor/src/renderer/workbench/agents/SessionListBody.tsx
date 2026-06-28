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

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  localize,
  IDialogService,
  IConfigurationService,
  ConfigurationTarget,
  IWorkspaceService,
  IHostService,
  IEditorService,
  IInstantiationService,
  arePathsEqual,
  type HostPlatform,
} from '@universe-editor/platform'
import { X, Trash2, GitBranch } from 'lucide-react'
import { IconButton, Input, fuzzyMatchField, scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type SessionHistoryScope,
} from '../../services/acp/acpSessionHistory.js'
import { IAcpSessionFilterService } from '../../services/acp/acpSessionFilterService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { AgentIcon } from './agentIcon.js'
import { useSessionTimer, formatRunningTime } from './useSessionTimer.js'
import { formatCny } from './SessionCostIndicator.js'
import { useUsdToCnyRate } from './useExchangeRate.js'
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

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return localize('agent.history.justNow', 'just now')
  if (diff < 3_600_000)
    return localize('agent.history.minutesAgo', '{count}m ago', {
      count: Math.floor(diff / 60_000),
    })
  if (diff < 86_400_000)
    return localize('agent.history.hoursAgo', '{count}h ago', {
      count: Math.floor(diff / 3_600_000),
    })
  return localize('agent.history.daysAgo', '{count}d ago', {
    count: Math.floor(diff / 86_400_000),
  })
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

export interface SessionListBodyProps {
  /** Suppress the inline "no sessions" line — popovers render their own. */
  hideEmptyState?: boolean
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
  onActivate,
  onRemove,
  rate,
  scope,
  isForeign,
}: {
  entry: AcpSessionHistoryEntry
  liveSession: IAcpSession | undefined
  isActive: boolean
  onActivate: () => void
  onRemove: () => void
  rate: number
  scope: SessionHistoryScope
  isForeign: boolean
}) {
  const isRunning = liveSession !== undefined
  const historyMs = entry.accumulatedRunningMs ?? 0
  const historyCostUsd = entry.usage?.cost?.amount
  const historyCostEstimated = entry.usage?.costEstimated === true
  const chip = scopeChip(entry, scope)
  return (
    <li
      className={styles['sessionRow']}
      data-active={isActive ? 'true' : 'false'}
      data-running={isRunning ? 'true' : 'false'}
      data-foreign={isForeign ? 'true' : 'false'}
      data-testid={`session-row-${entry.id}`}
      onClick={onActivate}
    >
      <div className={styles['sessionRowTitle']}>
        <span className={styles['sessionRowLabelLine']}>
          <AgentIcon agentId={entry.agentId} size={14} className={styles['sessionRowAgentIcon']} />
          <span className={styles['sessionRowLabel']}>{entry.title}</span>
          {isForeign ? (
            <GitBranch
              size={12}
              strokeWidth={1.75}
              className={styles['sessionRowForeignIcon']}
              aria-label={localize('acp.sessions.foreignWorktree', 'Belongs to another worktree')}
            />
          ) : null}
        </span>
        <span className={styles['sessionRowMeta']}>
          {relativeTime(entry.lastUsedAt)}
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
            <span className={styles['sessionRowScope']} title={chip.title}>
              {'‎' + chip.label}
            </span>
          ) : null}
        </span>
      </div>
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

export function SessionListBody({ hideEmptyState, onPick }: SessionListBodyProps) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const filterService = useService(IAcpSessionFilterService)
  const config = useService(IConfigurationService)
  const workspace = useService(IWorkspaceService)
  const hostService = useService(IHostService)
  const dialogService = useService(IDialogService)
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders.
  useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)

  const searchOpen = useObservable(filterService.searchOpen)
  const query = useObservable(filterService.query)

  // The config service exposes an Event, not an observable — mirror the scope
  // into local state so the list re-renders (and re-filters) when it changes.
  const [scope, setScope] = useState<SessionHistoryScope>(() => readHistoryScope(config))
  useEffect(() => {
    const d = config.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(HISTORY_SCOPE_KEY)) setScope(readHistoryScope(config))
    })
    return () => d.dispose()
  }, [config])

  const platform: HostPlatform = hostService.platform
  const currentCwd = workspace.current?.folder.fsPath

  // In `workspace` scope keep only exact-cwd rows so narrowing applies instantly
  // without waiting for the next replace-mode hydrate. `worktree`/`all` trust the
  // hydrate sweep's scoping (which already bounds what the bucket contains).
  const scoped = useMemo(() => {
    if (scope !== 'workspace' || currentCwd === undefined) return entries
    return entries.filter((e) => e.cwd === undefined || arePathsEqual(e.cwd, currentCwd, platform))
  }, [entries, scope, currentCwd, platform])

  const filtered = useMemo(() => filterSessions(scoped, query), [scoped, query])

  const exchangeRate = useUsdToCnyRate()
  const rate = exchangeRate?.rate ?? FALLBACK_RATE

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      filterService.closeSearch()
    }
  }

  if (entries.length === 0) {
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
      {filtered.length === 0 ? (
        <p className={styles['empty']}>
          {localize('acp.sessions.noMatch', 'No matching sessions.')}
        </p>
      ) : (
        <ul className={styles['sessionRows']}>
          {filtered.map((entry) => {
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
              !arePathsEqual(entry.cwd, currentCwd, platform)
            return (
              <SessionRow
                key={entry.id}
                entry={entry}
                liveSession={liveSession}
                isActive={isActive}
                rate={rate}
                scope={scope}
                isForeign={isForeign}
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
                    !arePathsEqual(entry.cwd, currentCwd, platform)
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
                onRemove={() => {
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
                        neverAskAgainLabel: localize(
                          'acp.sessions.removeNeverAsk',
                          "Don't ask again",
                        ),
                      })
                      if (!result.confirmed) return
                      if (result.neverAskAgain) {
                        config.update('acp.sessions.confirmDelete', false, ConfigurationTarget.User)
                      }
                    }
                    if (liveSession) await service.closeSession(liveSession.id)
                    await service.deleteOnAgent(entry.id)
                    history.remove(entry.id)
                  })()
                }}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
}
