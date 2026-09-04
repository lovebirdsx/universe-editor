/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentSessionButtons — title-bar (right side) agent actions: New session and
 *  Choose agent (shows the current default agent's icon). Session creation lives
 *  here (the `+` button), while Choose Agent only switches the default agent.
 *--------------------------------------------------------------------------------------------*/

import { IconButton } from '@universe-editor/workbench-ui'
import { ICommandService, localize } from '@universe-editor/platform'
import { Plus } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { AgentIcon } from '../agents/agentIcon.js'
import styles from './AgentSessionButtons.module.css'

export function AgentSessionButtons() {
  const commands = useService(ICommandService)
  const registry = useService(IAcpAgentRegistry)
  const defaultAgentId = useObservable(registry.defaultAgentIdObs)

  return (
    <div className={styles['buttons']}>
      <IconButton
        label={localize('acp.newSession', 'New session')}
        command="workbench.action.agent.newSession"
        onClick={() => void commands.executeCommand('workbench.action.agent.newSession')}
        data-testid="titlebar-new-session"
      >
        <Plus size={14} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={localize('acp.selectAgent', 'Choose agent…')}
        command="workbench.action.agent.selectAgent"
        data-tooltip={localize('acp.selectAgent.titled', 'Choose agent… (current: {name})', {
          name: defaultAgentId,
        })}
        onClick={() => void commands.executeCommand('workbench.action.agent.selectAgent')}
        data-testid="titlebar-select-agent"
      >
        <AgentIcon agentId={defaultAgentId} size={13} />
      </IconButton>
    </div>
  )
}
