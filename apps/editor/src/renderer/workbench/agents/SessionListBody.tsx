/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListBody — the pure list rendering reused by SessionListPanel (full
 *  sidebar view) and SessionsPopover (Copilot-style dropdown). Picks resolve
 *  a live session if one exists, otherwise call `resumeSession`. The optional
 *  `onPick` callback fires after the click handler kicks off so consumers can
 *  collapse the popover or otherwise react to the selection.
 *--------------------------------------------------------------------------------------------*/

import { IEditorService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/acpSessionHistory.js'
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
   * Called after a row is picked (single click or resume kicked off). The
   * popover variant uses this to dismiss itself. The list still drives the
   * actual session activation; this hook is fire-and-forget.
   */
  onPick?: (entry: AcpSessionHistoryEntry) => void
  /**
   * Suppress the double-click-promotes-to-editor affordance. Useful inside the
   * popover where the user is already in sidebar mode and probably doesn't
   * want an Editor tab spawned out from under them.
   */
  disableOpenInEditor?: boolean
}

export function SessionListBody({
  hideEmptyState,
  onPick,
  disableOpenInEditor,
}: SessionListBodyProps) {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const editor = useService(IEditorService)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders.
  useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)

  if (entries.length === 0) {
    if (hideEmptyState) return null
    return <p className={styles['empty']}>{localize('acp.sessions.empty', 'No sessions yet.')}</p>
  }

  return (
    <ul>
      {entries.map((entry) => {
        const running = service.getByHistoryId(entry.id)
        const isActive = running !== undefined && running.id === activeId
        return (
          <li
            key={entry.id}
            className={styles['sessionRow']}
            data-active={isActive ? 'true' : 'false'}
            data-running={running !== undefined ? 'true' : 'false'}
            onClick={() => {
              if (running) {
                service.setActive(running.id)
              } else {
                service.resumeSession(entry.id).catch(() => {
                  // resumeSession publishes its own notification.
                })
              }
              onPick?.(entry)
            }}
            onDoubleClick={() => {
              if (disableOpenInEditor) return
              editor.openEditor(
                new AcpSessionEditorInput(running?.id ?? entry.id, entry.agentId, entry.id),
              )
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
