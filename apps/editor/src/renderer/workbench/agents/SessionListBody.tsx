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

import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { X } from 'lucide-react'
import { IconButton, Input, fuzzyMatchField, scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/acpSessionHistory.js'
import { IAcpSessionFilterService } from '../../services/acp/acpSessionFilterService.js'
import { AgentIcon } from './agentIcon.js'
import { useSessionTimer, formatRunningTime } from './useSessionTimer.js'
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

function LiveSessionTimer({ session }: { session: IAcpSession }) {
  const ms = useSessionTimer(session)
  if (ms === 0) return null
  return <span className={styles['sessionRowTimer']}>{formatRunningTime(ms)}</span>
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
}: {
  entry: AcpSessionHistoryEntry
  liveSession: IAcpSession | undefined
  isActive: boolean
  onActivate: () => void
  onRemove: () => void
}) {
  const isRunning = liveSession !== undefined
  const historyMs = entry.accumulatedRunningMs ?? 0
  return (
    <li
      className={styles['sessionRow']}
      data-active={isActive ? 'true' : 'false'}
      data-running={isRunning ? 'true' : 'false'}
      data-testid={`session-row-${entry.id}`}
      onClick={onActivate}
    >
      <div className={styles['sessionRowTitle']}>
        <span className={styles['sessionRowLabelLine']}>
          <AgentIcon agentId={entry.agentId} size={14} className={styles['sessionRowAgentIcon']} />
          <span className={styles['sessionRowLabel']}>{entry.title}</span>
        </span>
        <span className={styles['sessionRowMeta']}>
          {relativeTime(entry.lastUsedAt)}
          {liveSession !== undefined ? (
            <LiveSessionTimer session={liveSession} />
          ) : historyMs > 0 ? (
            <span className={styles['sessionRowTimer']}>{formatRunningTime(historyMs)}</span>
          ) : null}
        </span>
      </div>
      <button
        type="button"
        className={styles['sessionClose']}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label="Remove session"
      >
        ×
      </button>
    </li>
  )
}

export function SessionListBody({ hideEmptyState, onPick }: SessionListBodyProps) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const filterService = useService(IAcpSessionFilterService)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders.
  useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)

  const searchOpen = useObservable(filterService.searchOpen)
  const query = useObservable(filterService.query)
  const filtered = useMemo(() => filterSessions(entries, query), [entries, query])

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
            const liveSession = live && live.status.get() !== 'closed' ? live : undefined
            const isActive = liveSession !== undefined && liveSession.id === activeId
            return (
              <SessionRow
                key={entry.id}
                entry={entry}
                liveSession={liveSession}
                isActive={isActive}
                onActivate={() => {
                  const fresh = service.getById(entry.id)
                  const liveNow = fresh && fresh.status.get() !== 'closed' ? fresh : undefined
                  if (liveNow) {
                    service.setActive(liveNow.id)
                  } else {
                    service.resumeSession(entry.id).catch(() => {
                      // resumeSession publishes its own notification.
                    })
                  }
                  onPick?.(entry)
                }}
                onRemove={() => {
                  void (async () => {
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
