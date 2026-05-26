/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListBody — the pure list rendering reused by SessionListPanel (full
 *  sidebar view) and SessionsPopover (Copilot-style dropdown). Click behavior
 *  depends on the global chat location: editor mode opens (or focuses) a tab,
 *  sidebar mode just flips the active session. The optional `onPick` callback
 *  fires afterwards so popovers can collapse themselves.
 *--------------------------------------------------------------------------------------------*/

import { IEditorService, IInstantiationService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import styles from './agents.module.css'

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

export function SessionListBody({ hideEmptyState, onPick }: SessionListBodyProps) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const editor = useService(IEditorService)
  const inst = useService(IInstantiationService)
  const location = useService(IAcpChatLocationService)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders.
  useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)
  const currentLocation = useObservable(location.location)

  if (entries.length === 0) {
    if (hideEmptyState) return null
    return <p className={styles['empty']}>{localize('acp.sessions.empty', 'No sessions yet.')}</p>
  }

  return (
    <ul>
      {entries.map((entry) => {
        const running = service.getById(entry.id)
        const isActive = running !== undefined && running.id === activeId
        return (
          <li
            key={entry.id}
            className={styles['sessionRow']}
            data-active={isActive ? 'true' : 'false'}
            data-running={running !== undefined ? 'true' : 'false'}
            onClick={() => {
              if (currentLocation === 'editor') {
                // Editor mode: open (or focus) the tab. The editor's useEffect
                // takes care of resuming if the session isn't live yet — we
                // don't fire resumeSession here to avoid double-invoking it.
                editor.openEditor(
                  inst.createInstance(AcpSessionEditorInput, entry.id, entry.agentId),
                )
                if (running) service.setActive(running.id)
              } else {
                // Sidebar mode: just flip activeSession. No tab is opened.
                if (running) {
                  service.setActive(running.id)
                } else {
                  service.resumeSession(entry.id).catch(() => {
                    // resumeSession publishes its own notification.
                  })
                }
              }
              onPick?.(entry)
            }}
          >
            <div className={styles['sessionRowTitle']}>
              <span className={styles['sessionRowLabel']}>{entry.title}</span>
              <span className={styles['sessionRowMeta']}>{relativeTime(entry.lastUsedAt)}</span>
            </div>
            <button
              type="button"
              className={styles['sessionClose']}
              onClick={(e) => {
                e.stopPropagation()
                void (async () => {
                  if (running) await service.closeSession(running.id)
                  await service.deleteOnAgent(entry.id)
                  history.remove(entry.id)
                })()
              }}
              aria-label="Remove session"
            >
              ×
            </button>
          </li>
        )
      })}
    </ul>
  )
}
