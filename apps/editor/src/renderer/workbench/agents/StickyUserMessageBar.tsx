/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyUserMessageBar — pins the latest user message above the chat scroll,
 *  mirroring StickyPlanBar. The message stays in the timeline as part of the
 *  history; this bar is the always-visible copy so the active request never
 *  scrolls out of view. Expanded (the default) it shows the full content;
 *  collapsed it shows the first line. Returns null until a user message exists.
 *--------------------------------------------------------------------------------------------*/

import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ICommandService, IContextKeyService } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession, TimelineItem } from '../../services/acp/acpSessionService.js'
import { IAcpChatWidgetService } from '../../services/acp/acpChatWidgetService.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { MessageContent } from './MessageContent.js'
import { roleIcon } from './timelineIcons.js'
import { AgentChatContextMenu, type AgentChatContextMenuState } from './AgentChatContextMenu.js'
import { itemSlotKey } from './stickyScroll.js'
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
  onFocusSlot,
}: {
  session: IAcpSession
  onFocusSlot?: (key: string) => void
}) {
  const timeline = useObservable(session.timeline)
  const [collapsed, setCollapsed] = useState(() => userBarCollapsedCache.get(session.id) ?? false)
  const [menu, setMenu] = useState<AgentChatContextMenuState | null>(null)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const widgetService = useService(IAcpChatWidgetService)

  const item = firstUserItem(timeline)
  if (!item) return null

  const message = item.message
  const slotKey = itemSlotKey(item)

  const toggle = (): void =>
    setCollapsed((v) => {
      const next = !v
      userBarCollapsedCache.set(session.id, next)
      return next
    })

  const handleContextMenu = (e: ReactMouseEvent): void => {
    e.preventDefault()
    onFocusSlot?.(slotKey)
    widgetService.setHasSelection(!!window.getSelection()?.toString())
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <ul
      className={styles['stickyUserBar']}
      data-testid="acp-user-bar"
      data-timeline-key={slotKey}
      onContextMenu={handleContextMenu}
    >
      <CollapsibleSlot
        as="li"
        icon={roleIcon('user')}
        kindLabel="user"
        summary={clampLine(message.text)}
        collapsed={collapsed}
        onToggle={toggle}
        rootProps={{ className: styles['planCard'] ?? '', 'data-testid': 'acp-user-bar-card' }}
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
