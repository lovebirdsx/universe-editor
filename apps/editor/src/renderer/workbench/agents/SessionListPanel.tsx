/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListPanel — what the AGENTS view shows in SecondarySideBar when Chat
 *  lives in the EditorArea. A small toolbar (New / Switch agent / Switch to
 *  Sidebar) plus the shared SessionListBody. Picking a row resumes/activates
 *  the session through SessionListBody's built-in click handling; we don't
 *  override onPick because the user expects the editor tab to follow.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { SessionListBody } from './SessionListBody.js'
import styles from './agents.module.css'

export function SessionListPanel() {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const commands = useService(ICommandService)
  const location = useService(IAcpChatLocationService)

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
        <button
          type="button"
          onClick={() => location.setLocation('sidebar')}
          data-testid="acp-switch-to-sidebar"
          title={localize('acp.switchToSidebar.tooltip', 'Move chat into the sidebar')}
        >
          {localize('acp.switchToSidebar', '⇄ Sidebar')}
        </button>
      </div>
      <SessionListBody />
    </div>
  )
}
