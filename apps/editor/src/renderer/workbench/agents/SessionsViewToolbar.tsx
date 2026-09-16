/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionsViewToolbar — the title-bar actions for the Sessions view, rendered in the
 *  view's ViewPane header via the view toolbar registry: search, filter, New,
 *  choose-agent and refresh over the session list.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { ICommandService, localize } from '@universe-editor/platform'
import { ChevronDown, Filter, Plus, RefreshCw, Search } from 'lucide-react'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpSessionFilterService } from '../../services/acp/session/acpSessionFilterService.js'
import { AgentIcon } from './agentIcon.js'
import { SessionsFilterPopover } from './SessionsFilterPopover.js'
import styles from './agents.module.css'

export function SessionsViewToolbar() {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const commands = useService(ICommandService)
  const filterService = useService(IAcpSessionFilterService)
  const searchOpen = useObservable(filterService.searchOpen)
  const filterDefault = useObservable(filterService.isFilterDefault)
  const defaultAgentId = useObservable(registry.defaultAgentIdObs)
  const [refreshing, setRefreshing] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void service.refreshSessions().finally(() => setRefreshing(false))
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
      {filterOpen && <SessionsFilterPopover onDismiss={() => setFilterOpen(false)} />}
    </span>
  )
}
