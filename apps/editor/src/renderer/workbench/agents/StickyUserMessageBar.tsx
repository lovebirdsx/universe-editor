/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyUserMessageBar — pins the latest user message above the chat scroll,
 *  mirroring StickyPlanBar. The message stays in the timeline as part of the
 *  history; this bar is the always-visible copy so the active request never
 *  scrolls out of view. Expanded (the default) it shows the full content;
 *  collapsed it shows the first line. Returns null until a user message exists.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import { ICommandService, IContextKeyService } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, TimelineItem } from '../../services/acp/acpSessionService.js'
import { IAcpChatWidgetService } from '../../services/acp/acpChatWidgetService.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { MessageContent } from './MessageContent.js'
import { roleIcon } from './timelineIcons.js'
import { AgentChatContextMenu, type AgentChatContextMenuState } from './AgentChatContextMenu.js'
import { itemSlotKey } from './stickyScroll.js'
import type { WidgetHandle } from './ChatBody.js'
import styles from './agents.module.css'

const SUMMARY_MAX = 80

// Per-session collapse state, in-memory like StickyPlanBar's.
const userBarCollapsedCache = new Map<string, boolean>()

function clampLine(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine
}

function firstUserItem(
  timeline: readonly TimelineItem[],
): (TimelineItem & { kind: 'message' }) | undefined {
  for (let i = 0; i < timeline.length; i++) {
    const it = timeline[i]
    if (it?.kind === 'message' && it.message.role === 'user')
      return it as TimelineItem & { kind: 'message' }
  }
  return undefined
}

export function StickyUserMessageBar({
  session,
  handleRef,
  onFocusSlot,
}: {
  session: IAcpSession
  handleRef?: MutableRefObject<WidgetHandle>
  onFocusSlot?: (key: string) => void
}) {
  const timeline = useObservable(session.timeline)
  const [collapsed, setCollapsed] = useState(() => userBarCollapsedCache.get(session.id) ?? false)
  const [menu, setMenu] = useState<AgentChatContextMenuState | null>(null)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const widgetService = useService(IAcpChatWidgetService)

  const item = firstUserItem(timeline)
  const slotKey = item ? itemSlotKey(item) : null

  // Keyboard focus (Alt+A/E/J/K) can land on this bar — it renders the first user
  // message, which is part of the navigation sequence but lives outside the scroll
  // container, so it tracks the focused key through the widget handle.
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const handle = handleRef?.current
    if (!handle || slotKey === null) return
    const sync = (): void => setFocused(handle.getFocusedKey() === slotKey)
    sync()
    const sub = handle.onDidChangeFocusedKey(sync)
    return () => sub.dispose()
  }, [handleRef, slotKey])

  if (!item) return null

  const message = item.message

  const toggle = (): void =>
    setCollapsed((v) => {
      const next = !v
      userBarCollapsedCache.set(session.id, next)
      return next
    })

  const handleContextMenu = (e: ReactMouseEvent): void => {
    e.preventDefault()
    if (slotKey !== null) onFocusSlot?.(slotKey)
    widgetService.setHasSelection(!!window.getSelection()?.toString())
    setMenu({ x: e.clientX, y: e.clientY, args: [{ sessionId: session.id }] })
  }

  return (
    <ul
      className={styles['stickyUserBar']}
      data-testid="acp-user-bar"
      data-timeline-key={slotKey ?? undefined}
      onContextMenu={handleContextMenu}
    >
      <CollapsibleSlot
        as="li"
        icon={roleIcon('user')}
        kindLabel="user"
        summary={clampLine(message.text)}
        collapsed={collapsed}
        onToggle={toggle}
        rootProps={{
          // The focus ring goes on the card (inset by the bar's 12px padding),
          // not the full-width <ul> — a ring at the chat edge gets painted over
          // by the workbench boundary sash. Matches in-list TimelineSlot focus.
          className: `${styles['planCard'] ?? ''}${focused ? ` ${styles['timelineSlotFocused']}` : ''}`,
          'data-testid': 'acp-user-bar-card',
        }}
      >
        <MessageContent blocks={message.blocks} />
      </CollapsibleSlot>
      {menu && (
        <AgentChatContextMenu
          state={menu}
          commandService={commandService}
          contextKeyService={contextKeyService}
          onClose={() => {
            setMenu(null)
            widgetService.setHasSelection(false)
          }}
        />
      )}
    </ul>
  )
}
