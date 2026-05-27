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
 *
 *  Keyboard navigation: while ChatBody is mounted, the `acpTimelineFocusable`
 *  contextKey is true so Alt+J / Alt+K dispatch through the timeline-move
 *  event bus on IAcpFocusService. ChatScroll moves a "focused" item indicator
 *  one slot at a time (VSCode chat-style), scrolls it into view and disables
 *  the auto-stick-to-bottom so streaming chunks don't yank focus away.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { IContextKeyService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpFocusService } from '../../services/acp/acpFocusService.js'
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
  const focusService = useService(IAcpFocusService)
  const contextKeyService = useService(IContextKeyService)
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

  // Seed the gating contextKey while ChatBody is mounted — actions check it
  // in their `when` clause to scope Alt+J / Alt+K to the ACP view only.
  // Default false so reset() (which re-applies the default) clears it on
  // unmount; we flip it true imperatively.
  useEffect(() => {
    const key = contextKeyService.createKey<boolean>('acpTimelineFocusable', false)
    key.set(true)
    return () => key.reset()
  }, [contextKeyService])

  // Keep latest timeline available to the event handler without re-subscribing
  // on every render — capturing timeline in the effect deps would tear the
  // subscription mid-stream and lose events fired within the same tick.
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline

  useEffect(() => {
    const sub = focusService.onDidRequestTimelineMove((direction) => {
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
    })
    return () => sub.dispose()
  }, [focusService])

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
      return (
        <li
          className={styles['messageItem'] + focusedClass}
          data-role={m.role}
          data-testid={`acp-message-${m.role}`}
          data-timeline-key={key}
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
