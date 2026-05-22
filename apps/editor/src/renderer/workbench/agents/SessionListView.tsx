/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListView — secondary sidebar view listing all open sessions. Click to
 *  set active; double-click promotes to a full-screen editor tab.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, IEditorService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import styles from './agents.module.css'

export function SessionListView() {
  const service = useService(IAcpSessionService)
  const editor = useService(IEditorService)
  const commands = useService(ICommandService)
  const registry = useService(IAcpAgentRegistry)
  const sessions = useObservable(service.sessions)
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
      {sessions.length === 0 ? (
        <p className={styles['empty']}>{localize('acp.sessions.empty', 'No sessions yet.')}</p>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={styles['sessionRow']}
              data-active={s.id === activeId}
              onClick={() => service.setActive(s.id)}
              onDoubleClick={() =>
                editor.openEditor(new AcpSessionEditorInput(s.id, s.agentId, s.historyId))
              }
            >
              <span className={styles['sessionRowTitle']}>{s.title}</span>
              <button
                type="button"
                className={styles['sessionClose']}
                onClick={(e) => {
                  e.stopPropagation()
                  void service.closeSession(s.id)
                }}
                aria-label="Close session"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
