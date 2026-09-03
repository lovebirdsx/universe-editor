/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentsViewToolbar — the title-bar actions for the AGENTS view, rendered in the
 *  view's ViewPane header via the view toolbar registry. The button set follows the chat
 *  location: docked in the sidebar (ChatPanel) it offers the sessions popover,
 *  New and switch-to-editor; parked in the editor area (SessionListPanel) it
 *  offers New, choose-agent, refresh and switch-to-sidebar.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { ICommandService, localize } from '@universe-editor/platform'
import { ArrowLeftRight, ChevronDown, Filter, Plus, RefreshCw, Search } from 'lucide-react'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../../services/acp/session/acpChatLocationService.js'
import { IAcpSessionFilterService } from '../../services/acp/session/acpSessionFilterService.js'
import { AgentIcon } from './agentIcon.js'
import { SessionsPopover } from './SessionsPopover.js'
import { SessionsFilterPopover } from './SessionsFilterPopover.js'
import styles from './agents.module.css'

export function AgentsViewToolbar() {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const commands = useService(ICommandService)
  const location = useService(IAcpChatLocationService)
  const filterService = useService(IAcpSessionFilterService)
  const loc = useObservable(location.location)
  const sidebarEnabled = useObservable(location.sidebarEnabled)
  const searchOpen = useObservable(filterService.searchOpen)
  const filterDefault = useObservable(filterService.isFilterDefault)
  const defaultAgentId = useObservable(registry.defaultAgentIdObs)
  const [refreshing, setRefreshing] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void service.refreshSessions().finally(() => setRefreshing(false))
  }

  if (loc === 'sidebar') {
    return (
      <span className={styles['viewToolbar']}>
        <IconButton
          label={localize('acp.find.open', 'Find in session')}
          command="workbench.action.agent.find"
          onClick={() => void commands.executeCommand('workbench.action.agent.find')}
          data-testid="acp-find-open"
        >
          <Search size={14} strokeWidth={1.75} />
        </IconButton>
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
          command="workbench.action.agent.newSession"
          onClick={() => void service.createSession(registry.defaultAgentId())}
          data-testid="acp-new-session"
        >
          <AgentIcon agentId={defaultAgentId} size={13} className={styles['chatTitleAgentIcon']} />
        </IconButton>
        <IconButton
          label={localize('acp.newSession.withScope', 'New session in…')}
          command="workbench.action.agent.newSessionWithScope"
          onClick={() => void commands.executeCommand('workbench.action.agent.newSessionWithScope')}
          data-testid="acp-new-session-scope"
        >
          <ChevronDown size={14} strokeWidth={1.75} />
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
        label={localize('acp.sessions.search', 'Search sessions')}
        active={searchOpen}
        onClick={() => filterService.toggleSearch()}
        data-testid="acp-session-search"
      >
        <Search size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.filter.menu', 'Filter sessions')}
        active={filterOpen || !filterDefault}
        onClick={() => setFilterOpen((v) => !v)}
        aria-expanded={filterOpen}
        aria-haspopup="menu"
        data-testid="acp-session-filter"
      >
        <Filter size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.newSession', 'New session')}
        command="workbench.action.agent.newSession"
        onClick={() => void service.createSession(registry.defaultAgentId())}
        data-testid="acp-new-session"
      >
        <Plus size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.newSession.withScope', 'New session in…')}
        command="workbench.action.agent.newSessionWithScope"
        onClick={() => void commands.executeCommand('workbench.action.agent.newSessionWithScope')}
        data-testid="acp-new-session-scope"
      >
        <ChevronDown size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.selectAgent', 'Choose agent…')}
        command="workbench.action.agent.selectAgent"
        data-tooltip={localize('acp.selectAgent.titled', 'Choose agent… (current: {name})', {
          name: defaultAgentId,
        })}
        onClick={() => void commands.executeCommand('workbench.action.agent.selectAgent')}
        data-testid="acp-select-agent"
      >
        <AgentIcon agentId={defaultAgentId} size={14} />
      </IconButton>
      <IconButton
        label={localize('acp.refreshSessions', 'Refresh session list')}
        command="workbench.action.agent.refreshSessions"
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
      {sidebarEnabled && (
        <IconButton
          label={localize('acp.switchToSidebar.tooltip', 'Move chat into the sidebar')}
          onClick={() => location.setLocation('sidebar')}
          data-testid="acp-switch-to-sidebar"
        >
          <ArrowLeftRight size={14} strokeWidth={1.75} />
        </IconButton>
      )}
      {filterOpen && <SessionsFilterPopover onDismiss={() => setFilterOpen(false)} />}
    </span>
  )
}
