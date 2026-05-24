/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListPanel — what the AGENTS view shows in SecondarySideBar when Chat
 *  lives in the EditorArea. A small toolbar (New / Switch agent / Switch to
 *  Sidebar) plus the shared SessionListBody. Picking a row resumes/activates
 *  the session through SessionListBody's built-in click handling; we don't
 *  override onPick because the user expects the editor tab to follow.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, localize } from '@universe-editor/platform'
import { ArrowLeftRight, Bot, Plus } from 'lucide-react'
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
          className={styles['toolbarButton']}
          onClick={() => void service.createSession(registry.defaultAgentId())}
          data-testid="acp-new-session"
          title={localize('acp.newSession', 'New session')}
          aria-label={localize('acp.newSession', 'New session')}
        >
          <span aria-hidden="true">
            <Plus size={14} strokeWidth={1.75} />
          </span>
        </button>
        <button
          type="button"
          className={styles['toolbarButton']}
          onClick={() => void commands.executeCommand('workbench.action.agent.selectAgent')}
          data-testid="acp-select-agent"
          title={localize('acp.selectAgent', 'Switch agent…')}
          aria-label={localize('acp.selectAgent', 'Switch agent…')}
        >
          <span aria-hidden="true">
            <Bot size={14} strokeWidth={1.75} />
          </span>
        </button>
        <button
          type="button"
          className={styles['toolbarButton']}
          onClick={() => location.setLocation('sidebar')}
          data-testid="acp-switch-to-sidebar"
          title={localize('acp.switchToSidebar.tooltip', 'Move chat into the sidebar')}
          aria-label={localize('acp.switchToSidebar.tooltip', 'Move chat into the sidebar')}
        >
          <span aria-hidden="true">
            <ArrowLeftRight size={14} strokeWidth={1.75} />
          </span>
        </button>
      </div>
      <SessionListBody />
    </div>
  )
}
