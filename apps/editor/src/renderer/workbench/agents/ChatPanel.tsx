/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatPanel — the Copilot-style sidebar layout. A thin toolbar pinned to the
 *  top (Sessions popover trigger + New + Switch to Editor) sits above ChatBody,
 *  which renders the active session's stream and the prompt input. Sessions
 *  popover lives here (not in ChatBody) so the Editor-area variant of
 *  AcpSessionEditor stays popover-free.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { ChatBody } from './ChatBody.js'
import { SessionsPopover } from './SessionsPopover.js'
import { AgentIcon } from './agentIcon.js'
import styles from './agents.module.css'

export function ChatPanel() {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const location = useService(IAcpChatLocationService)
  const active = useObservable(service.activeSession)
  const [sessionsOpen, setSessionsOpen] = useState(false)

  return (
    <div className={styles['chatPanel']} data-testid="acp-chat-panel">
      <div className={styles['chatToolbar']}>
        <div className={styles['chatToolbarLeft']}>
          <button
            type="button"
            className={styles['toolbarButton']}
            onClick={() => setSessionsOpen((v) => !v)}
            aria-expanded={sessionsOpen}
            aria-haspopup="listbox"
            data-testid="acp-toggle-sessions"
            title={localize('acp.sessions.toggle', 'Sessions')}
          >
            <span aria-hidden="true">📜</span>
          </button>
          <button
            type="button"
            className={styles['toolbarButton']}
            onClick={() => void service.createSession(registry.defaultAgentId())}
            data-testid="acp-new-session"
            title={localize('acp.newSession', 'New session')}
          >
            <span aria-hidden="true">⊕</span>
          </button>
        </div>
        <span className={styles['chatToolbarTitle']} data-testid="acp-chat-title">
          {active && (
            <AgentIcon
              agentId={active.agentId}
              size={14}
              className={styles['chatTitleAgentIcon']}
            />
          )}
          <span className={styles['chatTitleText']}>
            {active?.title ?? localize('acp.empty.short', 'No session')}
          </span>
        </span>
        <button
          type="button"
          className={styles['toolbarButton']}
          onClick={() => location.setLocation('editor')}
          data-testid="acp-switch-to-editor"
          title={localize('acp.switchToEditor.tooltip', 'Move chat to the editor area')}
        >
          <span aria-hidden="true">⇄</span>
        </button>
        {sessionsOpen && <SessionsPopover onDismiss={() => setSessionsOpen(false)} />}
      </div>
      <ChatBody />
    </div>
  )
}
