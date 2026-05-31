/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyPlanBar — renders the session plan as a bar pinned above the chat
 *  scroll. Plan is no longer a timeline slot (which scrolled out of view as
 *  later items piled up); it lives on `session.plan` and stays visible here
 *  while the agent works. Collapsed it shows `done/total` + the active task;
 *  expanded it shows the full checklist. Returns null until a plan arrives.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import { PlanCard } from './PlanView.js'
import styles from './agents.module.css'

// Per-session collapse state, in-memory like AcpChatViewStateCache. Kept here
// (rather than in that cache) because ChatScroll owns the cache entry and writes
// it as a whole — sharing it would clobber the scroll/focus fields.
const planCollapsedCache = new Map<string, boolean>()

export function StickyPlanBar({ session }: { session: IAcpSession }) {
  const entries = useObservable(session.plan)
  const [collapsed, setCollapsed] = useState(() => planCollapsedCache.get(session.id) ?? false)
  if (entries.length === 0) return null
  const toggle = (): void =>
    setCollapsed((v) => {
      const next = !v
      planCollapsedCache.set(session.id, next)
      return next
    })
  return (
    <ul className={styles['stickyPlanBar']} data-testid="acp-plan-bar">
      <PlanCard
        entries={entries}
        collapsed={collapsed}
        onToggle={toggle}
        rootProps={{ className: styles['planCard'] ?? '' }}
      />
    </ul>
  )
}
