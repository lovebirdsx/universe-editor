/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyUserMessageBar — pins the latest user message above the chat scroll,
 *  mirroring StickyPlanBar. The message stays in the timeline as part of the
 *  history; this bar is the always-visible copy so the active request never
 *  scrolls out of view. Collapsed (the default) it shows the first line;
 *  expanded it shows the full content. Returns null until a user message exists.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { useObservable } from '../useService.js'
import type { AcpMessage, IAcpSession, TimelineItem } from '../../services/acp/acpSessionService.js'
import { CollapsibleSlot } from './CollapsibleSlot.js'
import { MessageContent } from './MessageContent.js'
import { roleIcon } from './timelineIcons.js'
import styles from './agents.module.css'

const SUMMARY_MAX = 80

// Per-session collapse state, in-memory like StickyPlanBar's. Defaults to
// collapsed so the bar stays a one-line summary unless the user opens it.
const userBarCollapsedCache = new Map<string, boolean>()

function clampLine(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine
}

function lastUserMessage(timeline: readonly TimelineItem[]): AcpMessage | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i]
    if (it?.kind === 'message' && it.message.role === 'user') return it.message
  }
  return undefined
}

export function StickyUserMessageBar({ session }: { session: IAcpSession }) {
  const timeline = useObservable(session.timeline)
  const [collapsed, setCollapsed] = useState(() => userBarCollapsedCache.get(session.id) ?? true)
  const message = lastUserMessage(timeline)
  if (!message) return null
  const toggle = (): void =>
    setCollapsed((v) => {
      const next = !v
      userBarCollapsedCache.set(session.id, next)
      return next
    })
  return (
    <ul className={styles['stickyUserBar']} data-testid="acp-user-bar">
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
    </ul>
  )
}
