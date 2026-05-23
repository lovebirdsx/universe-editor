/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatBody — the Copilot-style stack rendered both by SecondarySideBar's
 *  ChatPanel and the full-screen AcpSessionEditor. No header chip; settings
 *  bar sits directly above the prompt input so user attention stays at the
 *  bottom of the panel where the action is.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
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

const STICK_THRESHOLD_PX = 32

export function ChatBody({ session }: { session?: IAcpSession }) {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const active = useObservable(service.activeSession)
  const target = session ?? active

  if (!target) {
    return <EmptyChat onCreate={() => void service.createSession(registry.defaultAgentId())} />
  }

  return (
    <div className={styles['chat']} data-testid="acp-chat">
      <ChatScroll session={target} />
      <PermissionCard session={target} />
      <ConfigOptionsBar session={target} />
      <PromptInput session={target} />
    </div>
  )
}

function ChatScroll({ session }: { session: IAcpSession }) {
  const messages = useObservable(session.messages)
  const toolCalls = useObservable(session.toolCalls)
  const plan = useObservable(session.plan)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop
    stickRef.current = distance <= STICK_THRESHOLD_PX
  }

  // Pin to bottom whenever the streamed content grows AND the user hasn't
  // scrolled up — matches Copilot's behavior of not yanking the viewport when
  // someone is reading older history.
  useEffect(() => {
    if (!stickRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, toolCalls.length, plan.length])

  return (
    <div ref={containerRef} className={styles['chatBody']} onScroll={handleScroll}>
      <PlanView session={session} />
      <MessageList session={session} />
      <ToolCallList session={session} />
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
