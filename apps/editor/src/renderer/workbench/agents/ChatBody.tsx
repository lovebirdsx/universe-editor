/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatBody — the Copilot-style stack rendered both by SecondarySideBar's
 *  ChatPanel and the full-screen AcpSessionEditor. Session-level config
 *  switches live inside PromptInput's action row to keep the bottom bar
 *  compact.
 *
 *  ChatScroll renders one unified timeline of message / tool_call / plan slots
 *  in arrival order — the canonical view-model is `session.timeline`. Each
 *  streaming agent / thought message shows a blinking caret until the chunk
 *  stream is flushed.
 *
 *  Keyboard navigation: ChatBody registers itself as an AcpChatWidget on
 *  mount. The widget service drives the `acpChatFocused` contextKey from
 *  focusin/focusout on this container, so Alt+J / Alt+K (and Ctrl+Alt+I) only
 *  target whichever ChatBody currently holds DOM focus.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  IAcpChatWidgetService,
  type AcpTimelineMoveDirection,
} from '../../services/acp/acpChatWidgetService.js'
import { MessageContent } from './MessageContent.js'
import { PermissionCard } from './PermissionCard.js'
import { PlanCard } from './PlanView.js'
import { PromptInput } from './PromptInput.js'
import { ToolCallCard } from './ToolCallCard.js'
import { UserMessageItem } from './UserMessageItem.js'
import styles from './agents.module.css'

const STICK_THRESHOLD_PX = 32

export interface WidgetHandle {
  move: (direction: AcpTimelineMoveDirection) => void
  focus: () => void
}

const noop = (): void => {}

export function ChatBody({ session, autoFocus }: { session?: IAcpSession; autoFocus?: boolean }) {
  const service = useService(IAcpSessionService)
  const registry = useService(IAcpAgentRegistry)
  const widgetService = useService(IAcpChatWidgetService)
  const active = useObservable(service.activeSession)
  const target = session ?? active
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<WidgetHandle>({ move: noop, focus: noop })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const sub = widgetService.register({
      container,
      moveTimeline: (d) => handleRef.current.move(d),
      focusInput: () => handleRef.current.focus(),
    })
    return () => sub.dispose()
  }, [widgetService, target?.id])

  if (!target) {
    return <EmptyChat onCreate={() => void service.createSession(registry.defaultAgentId())} />
  }

  return (
    <div ref={containerRef} className={styles['chat']} data-testid="acp-chat">
      <ChatScroll session={target} handleRef={handleRef} />
      <PermissionCard session={target} />
      <PromptInput
        session={target}
        handleRef={handleRef}
        {...(autoFocus !== undefined ? { autoFocus } : {})}
      />
    </div>
  )
}

function ChatScroll({
  session,
  handleRef,
}: {
  session: IAcpSession
  handleRef: MutableRefObject<WidgetHandle>
}) {
  const timeline = useObservable(session.timeline)
  const status = useObservable(session.status)
  const isRunning = status === 'running'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focusedKeyRef = useRef<string | null>(null)
  focusedKeyRef.current = focusedKey

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

  // Keep the timeline available to handle.move without re-binding the handle
  // on every render. Capturing timeline in the assignment would not be wrong,
  // but we'd re-allocate the closure on every render — the ref read is cheap.
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline

  useEffect(() => {
    const handle = handleRef.current
    handle.move = (direction) => {
      const list = timelineRef.current
      if (list.length === 0) return
      const keys = list.map(slotKey)
      const current = focusedKeyRef.current
      let nextIndex: number
      if (current === null) {
        nextIndex = direction === 'next' ? 0 : keys.length - 1
      } else {
        const idx = keys.indexOf(current)
        if (idx === -1) {
          nextIndex = direction === 'next' ? 0 : keys.length - 1
        } else if (direction === 'next') {
          nextIndex = Math.min(idx + 1, keys.length - 1)
        } else {
          nextIndex = Math.max(idx - 1, 0)
        }
      }
      const nextKey = keys[nextIndex]
      if (nextKey === undefined) return
      stickRef.current = false
      setFocusedKey(nextKey)
      const container = containerRef.current
      const el = container?.querySelector<HTMLElement>(
        `[data-timeline-key="${cssEscape(nextKey)}"]`,
      )
      el?.scrollIntoView({ block: 'nearest' })
    }
    return () => {
      handle.move = noop
    }
  }, [handleRef])

  return (
    <div ref={containerRef} className={styles['chatBody']} onScroll={handleScroll}>
      <ol className={styles['timeline']} data-testid="acp-timeline">
        {timeline.map((item) => {
          const key = slotKey(item)
          return (
            <TimelineSlot
              key={key}
              slotKey={key}
              item={item}
              sessionRunning={isRunning}
              isFocused={key === focusedKey}
            />
          )
        })}
      </ol>
    </div>
  )
}

function TimelineSlot({
  slotKey: key,
  item,
  sessionRunning,
  isFocused,
}: {
  slotKey: string
  item: TimelineItem
  sessionRunning: boolean
  isFocused: boolean
}) {
  const focusedClass = isFocused ? ` ${styles['timelineSlotFocused']}` : ''
  switch (item.kind) {
    case 'message': {
      const m = item.message
      const showCaret = sessionRunning && m.streaming
      const isUser = m.role === 'user'
      const className =
        styles['messageItem'] + (isUser ? ` ${styles['stickyUserMessage']}` : '') + focusedClass
      return (
        <li
          className={className}
          data-role={m.role}
          data-testid={`acp-message-${m.role}`}
          data-timeline-key={key}
        >
          <span className={styles['messageRole']}>{m.role}</span>
          {isUser ? <UserMessageItem blocks={m.blocks} /> : <MessageContent blocks={m.blocks} />}
          {showCaret && (
            <span className={styles['streamingCaret']} aria-hidden="true" data-testid="acp-caret">
              ▍
            </span>
          )}
        </li>
      )
    }
    case 'toolCall':
      return (
        <ToolCallCard
          call={item.call}
          dataTimelineKey={key}
          {...(isFocused ? { extraClassName: styles['timelineSlotFocused'] ?? '' } : {})}
        />
      )
    case 'plan':
      return (
        <li className={styles['timelinePlan'] + focusedClass} data-timeline-key={key}>
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

// Escape a string for use inside a CSS attribute selector. Timeline keys are
// shaped `m:<uuid>` / `t:<uuid>` / `p:plan` — colons are valid in CSS
// attribute *values* but escaping defensively guards against future id shapes.
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
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
