/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyUserMessageBar — pins, above the chat scroll, the user message for the
 *  section currently in view: the request that opened whatever exchange the
 *  viewport is reading, mirroring VSCode's sticky scroll. ChatScroll reports the
 *  active user slot key (resolved from the viewport-top anchor) through the
 *  `activeUserKey` observable; this bar looks it up in the timeline. ChatScroll
 *  reports null while the section's own prompt row is still visible in the
 *  timeline (a short conversation, or the newest section at the bottom) — pinning
 *  it then would show it twice — and this bar returns null in that case. The
 *  message stays in the timeline too; this bar is the always-visible copy so the
 *  section's prompt never scrolls out of view once it has left the viewport.
 *  Expanded (the default) it shows the full content; collapsed the first line.
 *  Returns null until a user message's section is pinned.
 *--------------------------------------------------------------------------------------------*/

import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ICommandService, IContextKeyService, type IObservable } from '@universe-editor/platform'
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

type UserMessageItem = TimelineItem & { kind: 'message' }

function isUserItem(it: TimelineItem | undefined): it is UserMessageItem {
  return it?.kind === 'message' && it.message.role === 'user'
}

// The section's user message, by the key ChatScroll resolved from the viewport.
// A null key means the section's prompt is still visible in the timeline (or no
// section is pinned yet), so the bar hides rather than duplicating it. A non-null
// key that no longer resolves (the card streamed away before the next report)
// also hides.
function activeUserItem(
  timeline: readonly TimelineItem[],
  activeKey: string | null,
): UserMessageItem | undefined {
  if (activeKey === null) return undefined
  const found = timeline.find((it) => itemSlotKey(it) === activeKey)
  return isUserItem(found) ? found : undefined
}

export function StickyUserMessageBar({
  session,
  activeUserKey,
  onFocusSlot,
}: {
  session: IAcpSession
  activeUserKey: IObservable<string | null>
  onFocusSlot?: (key: string) => void
}) {
  const timeline = useObservable(session.timeline)
  const activeKey = useObservable(activeUserKey)
  const [collapsed, setCollapsed] = useState(() => userBarCollapsedCache.get(session.id) ?? false)
  const [menu, setMenu] = useState<AgentChatContextMenuState | null>(null)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const widgetService = useService(IAcpChatWidgetService)

  const item = activeUserItem(timeline, activeKey)
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
    setMenu({ x: e.clientX, y: e.clientY, args: [{ sessionId: session.id }] })
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
