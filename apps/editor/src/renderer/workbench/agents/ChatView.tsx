/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatView — main Agent chat UI. Renders the active session's messages and a
 *  prompt input. Also shown by AcpSessionEditor (full-screen editor variant).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { ConfigOptionsBar } from './ConfigOptionsBar.js'
import { MessageList } from './MessageList.js'
import { PermissionCard } from './PermissionCard.js'
import { PlanView } from './PlanView.js'
import { PromptInput } from './PromptInput.js'
import { ToolCallList } from './ToolCallCard.js'
import styles from './agents.module.css'

export function ChatView({ session }: { session?: IAcpSession }) {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const active = useObservable(service.activeSession)
  const target = session ?? active

  if (!target) {
    return <EmptyChat onCreate={() => void service.createSession(registry.defaultAgentId())} />
  }

  return (
    <div className={styles['chat']} data-testid="acp-chat">
      <Header session={target} />
      <ConfigOptionsBar session={target} />
      <div className={styles['chatBody']}>
        <PlanView session={target} />
        <MessageList session={target} />
        <ToolCallList session={target} />
      </div>
      <PermissionCard session={target} />
      <PromptInput session={target} />
    </div>
  )
}

function Header({ session }: { session: IAcpSession }) {
  const status = useObservable(session.status)
  return (
    <div className={styles['chatHeader']}>
      <span className={styles['chatTitle']}>{session.title}</span>
      <span className={styles['chatStatus']} data-status={status}>
        {status}
      </span>
    </div>
  )
}

function EmptyChat({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles['emptyChat']}>
      <p>{localize('acp.empty', 'No active agent session.')}</p>
      <button type="button" className={styles['sendButton']} onClick={onCreate}>
        {localize('acp.newSession', 'New session')}
      </button>
    </div>
  )
}
