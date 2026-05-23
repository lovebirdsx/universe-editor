/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListView — secondary sidebar view backed by AcpSessionHistoryService.
 *  Running sessions are flagged inline via service.getByHistoryId(); click on a
 *  non-running row resumes it. Double-click promotes to a full-screen editor tab.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, IEditorService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpSessionHistoryService } from '../../services/acp/acpSessionHistory.js'
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

export function SessionListView() {
  const service = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const editor = useService(IEditorService)
  const commands = useService(ICommandService)
  const registry = useService(IAcpAgentRegistry)
  const entries = useObservable(history.entries)
  // Subscribe to sessions so the running indicator re-renders when a session is
  // created/closed; the lookup itself goes through getByHistoryId for clarity.
  useObservable(service.sessions)
  const activeId = useObservable(service.activeSessionId)

  return (
    <div className={styles['sessionList']} data-testid="acp-session-list">
      <div className={styles['sessionListToolbar']}>
        <button
          type="button"
          onClick={() => void service.createSession(registry.defaultAgentId())}
          data-testid="acp-new-session"
        >
          {localize('acp.newSession', 'New session')}
        </button>
        <button
          type="button"
          onClick={() => void commands.executeCommand('workbench.action.agent.selectAgent')}
          data-testid="acp-select-agent"
        >
          {localize('acp.selectAgent', 'Switch agent…')}
        </button>
      </div>
      {entries.length === 0 ? (
        <p className={styles['empty']}>{localize('acp.sessions.empty', 'No sessions yet.')}</p>
      ) : (
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
                }}
                onDoubleClick={() =>
                  editor.openEditor(
                    new AcpSessionEditorInput(running?.id ?? entry.id, entry.agentId, entry.id),
                  )
                }
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
      )}
    </div>
  )
}
