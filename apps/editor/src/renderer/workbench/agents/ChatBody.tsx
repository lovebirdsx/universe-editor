/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatBody — the Copilot-style stack rendered both by SecondarySideBar's
 *  ChatPanel and the full-screen AcpSessionEditor. No header chip; settings
 *  bar sits directly above the prompt input so user attention stays at the
 *  bottom of the panel where the action is.
 *
 *  ChatScroll renders one unified timeline of message / tool_call / plan slots
 *  in arrival order — the canonical view-model is `session.timeline`. Each
 *  streaming agent / thought message shows a blinking caret until the chunk
 *  stream is flushed.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { ConfigOptionsBar } from './ConfigOptionsBar.js'
import { MessageContent } from './MessageContent.js'
import { PermissionCard } from './PermissionCard.js'
import { PlanCard } from './PlanView.js'
import { PromptInput } from './PromptInput.js'
import { ToolCallCard } from './ToolCallCard.js'
import styles from './agents.module.css'

const STICK_THRESHOLD_PX = 32

export function ChatBody({ session, autoFocus }: { session?: IAcpSession; autoFocus?: boolean }) {
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
      <PromptInput session={target} {...(autoFocus !== undefined ? { autoFocus } : {})} />
    </div>
  )
}

function ChatScroll({ session }: { session: IAcpSession }) {
  const timeline = useObservable(session.timeline)
  const status = useObservable(session.status)
  const isRunning = status === 'running'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop
    stickRef.current = distance <= STICK_THRESHOLD_PX
  }

  // Re-pin on slot count AND on the tail's content size so streaming chunks
  // that grow within an existing slot (i.e. text appended to the last agent
  // message) still scroll into view.
  const tailSignature = tailContentSignature(timeline)

  useEffect(() => {
    if (!stickRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [timeline.length, tailSignature])

  return (
    <div ref={containerRef} className={styles['chatBody']} onScroll={handleScroll}>
      <ol className={styles['timeline']} data-testid="acp-timeline">
        {timeline.map((item) => (
          <TimelineSlot key={slotKey(item)} item={item} sessionRunning={isRunning} />
        ))}
      </ol>
    </div>
  )
}

function TimelineSlot({ item, sessionRunning }: { item: TimelineItem; sessionRunning: boolean }) {
  switch (item.kind) {
    case 'message': {
      const m = item.message
      const showCaret = sessionRunning && m.streaming
      return (
        <li
          className={styles['messageItem']}
          data-role={m.role}
          data-testid={`acp-message-${m.role}`}
        >
          <span className={styles['messageRole']}>{m.role}</span>
          <MessageContent blocks={m.blocks} />
          {showCaret && (
            <span className={styles['streamingCaret']} aria-hidden="true" data-testid="acp-caret">
              ▍
            </span>
          )}
        </li>
      )
    }
    case 'toolCall':
      return <ToolCallCard call={item.call} />
    case 'plan':
      return (
        <li className={styles['timelinePlan']}>
          <PlanCard entries={item.entries} />
        </li>
      )
  }
}

function slotKey(item: TimelineItem): string {
  switch (item.kind) {
    case 'message':
      return `m:${item.id}`
    case 'toolCall':
      return `t:${item.id}`
    case 'plan':
      return 'p:plan'
  }
}

function tailContentSignature(timeline: readonly TimelineItem[]): number {
  const last = timeline[timeline.length - 1]
  if (!last) return 0
  switch (last.kind) {
    case 'message':
      return last.message.text.length
    case 'toolCall':
      return last.call.text.length + last.call.status.length
    case 'plan':
      return last.entries.length
  }
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
