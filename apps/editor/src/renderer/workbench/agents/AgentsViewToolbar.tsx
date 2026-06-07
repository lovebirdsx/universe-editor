/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentsViewToolbar — the title-bar actions for the AGENTS view, rendered in the
 *  view's ViewPane header via viewToolbarMap. The button set follows the chat
 *  location: docked in the sidebar (ChatPanel) it offers the sessions popover,
 *  New and switch-to-editor; parked in the editor area (SessionListPanel) it
 *  offers New, choose-agent, refresh and switch-to-sidebar.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { ICommandService, localize } from '@universe-editor/platform'
import { ArrowLeftRight, Plus, RefreshCw } from 'lucide-react'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { AgentIcon } from './agentIcon.js'
import { SessionsPopover } from './SessionsPopover.js'
import styles from './agents.module.css'

export function AgentsViewToolbar() {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const commands = useService(ICommandService)
  const location = useService(IAcpChatLocationService)
  const loc = useObservable(location.location)
  const defaultAgentId = useObservable(registry.defaultAgentIdObs)
  const [refreshing, setRefreshing] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void service.refreshSessions().finally(() => setRefreshing(false))
  }

  if (loc === 'sidebar') {
    return (
      <span className={styles['viewToolbar']}>
        <IconButton
          label={localize('acp.sessions.toggle', 'Sessions')}
          onClick={() => setSessionsOpen((v) => !v)}
          aria-expanded={sessionsOpen}
          aria-haspopup="listbox"
          data-testid="acp-toggle-sessions"
        >
          <span aria-hidden="true">📜</span>
        </IconButton>
        <IconButton
          label={localize('acp.newSession.titled', 'New {name} session', { name: defaultAgentId })}
          onClick={() => void service.createSession(registry.defaultAgentId())}
          data-testid="acp-new-session"
        >
          <AgentIcon agentId={defaultAgentId} size={13} className={styles['chatTitleAgentIcon']} />
        </IconButton>
        <IconButton
          label={localize('acp.switchToEditor.tooltip', 'Move chat to the editor area')}
          onClick={() => location.setLocation('editor')}
          data-testid="acp-switch-to-editor"
        >
          <span aria-hidden="true">⇄</span>
        </IconButton>
        {sessionsOpen && <SessionsPopover onDismiss={() => setSessionsOpen(false)} />}
      </span>
    )
  }

  return (
    <span className={styles['viewToolbar']}>
      <IconButton
        label={localize('acp.newSession', 'New session')}
        onClick={() => void service.createSession(registry.defaultAgentId())}
        data-testid="acp-new-session"
      >
        <Plus size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.selectAgent', 'Choose agent…')}
        title={localize('acp.selectAgent.titled', 'Choose agent… (current: {name})', {
          name: defaultAgentId,
        })}
        onClick={() => void commands.executeCommand('workbench.action.agent.selectAgent')}
        data-testid="acp-select-agent"
      >
        <AgentIcon agentId={defaultAgentId} size={14} />
      </IconButton>
      <IconButton
        label={localize('acp.refreshSessions', 'Refresh session list')}
        onClick={handleRefresh}
        disabled={refreshing}
        data-testid="acp-refresh-sessions"
      >
        <RefreshCw
          size={14}
          strokeWidth={1.75}
          className={refreshing ? styles['spin'] : undefined}
        />
      </IconButton>
      <IconButton
        label={localize('acp.switchToSidebar.tooltip', 'Move chat into the sidebar')}
        onClick={() => location.setLocation('sidebar')}
        data-testid="acp-switch-to-sidebar"
      >
        <ArrowLeftRight size={14} strokeWidth={1.75} />
      </IconButton>
    </span>
  )
}
