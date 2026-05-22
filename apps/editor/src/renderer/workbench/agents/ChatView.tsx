/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatView — main Agent chat UI. Renders the active session's messages and a
 *  prompt input. Also shown by AcpSessionEditor (full-screen editor variant).
 *--------------------------------------------------------------------------------------------*/

import { useState, type FormEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { MessageList } from './MessageList.js'
import { PermissionCard } from './PermissionCard.js'
import { PlanView } from './PlanView.js'
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

function PromptInput({ session }: { session: IAcpSession }) {
  const [text, setText] = useState('')
  const status = useObservable(session.status)
  const running = status === 'running'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!text.trim() || running) return
    const value = text
    setText('')
    void session.sendPrompt(value)
  }

  return (
    <form className={styles['promptForm']} onSubmit={submit}>
      <textarea
        className={styles['promptTextarea']}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={localize('acp.prompt.placeholder', 'Ask the agent…')}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit(e)
          }
        }}
        data-testid="acp-prompt-input"
      />
      <div className={styles['promptActions']}>
        {running ? (
          <button
            type="button"
            className={styles['cancelButton']}
            onClick={() => void session.cancelTurn()}
            data-testid="acp-prompt-cancel"
          >
            {localize('acp.prompt.cancel', 'Cancel')}
          </button>
        ) : (
          <button
            type="submit"
            className={styles['sendButton']}
            disabled={!text.trim()}
            data-testid="acp-prompt-send"
          >
            {localize('acp.prompt.send', 'Send')}
          </button>
        )}
      </div>
    </form>
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
