/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyPlanBar — renders the session plan as a bar pinned above the chat
 *  scroll. Plan is no longer a timeline slot (which scrolled out of view as
 *  later items piled up); it lives on `session.plan` and stays visible here
 *  while the agent works. Collapsed it shows `done/total` + the active task;
 *  expanded it shows the full checklist. Returns null until a plan arrives.
 *
 *  The bar is a keyboard-navigation stop (PLAN_SLOT_KEY, right after the first
 *  user message): it tracks ChatScroll's focused key through the widget handle
 *  exactly like StickyUserMessageBar, and Alt+F folds it through `planBridge`
 *  since ChatScroll's timeline-keyed override store can't reach it.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type MutableRefObject } from 'react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { PlanCard } from './PlanView.js'
import { PLAN_SLOT_KEY } from './stickyScroll.js'
import type { PlanBridge, WidgetHandle } from './ChatBody.js'
import styles from './agents.module.css'

// Per-session collapse state, in-memory like AcpChatViewStateCache. Kept here
// (rather than in that cache) because ChatScroll owns the cache entry and writes
// it as a whole — sharing it would clobber the scroll/focus fields.
const planCollapsedCache = new Map<string, boolean>()

export function StickyPlanBar({
  session,
  handleRef,
  onFocusSlot,
  planBridge,
}: {
  session: IAcpSession
  handleRef?: MutableRefObject<WidgetHandle>
  onFocusSlot?: (key: string) => void
  planBridge?: PlanBridge
}) {
  const entries = useObservable(session.plan)
  const [collapsed, setCollapsed] = useState(() => planCollapsedCache.get(session.id) ?? false)

  // Keyboard focus (Alt+J/K/P) can land on this bar — it lives outside the
  // scroll container, so it tracks the focused key through the widget handle.
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const handle = handleRef?.current
    if (!handle) return
    const syncFocus = (): void => setFocused(handle.getFocusedKey() === PLAN_SLOT_KEY)
    syncFocus()
    const sub = handle.onDidChangeFocusedKey(syncFocus)
    return () => sub.dispose()
  }, [handleRef])

  if (entries.length === 0) return null
  const toggle = (): void =>
    setCollapsed((v) => {
      const next = !v
      planCollapsedCache.set(session.id, next)
      return next
    })
  // Render-phase assignment (same pattern as ChatBody's bridges): the bar mounts
  // before ChatScroll's handle-binding effect, so Alt+F must find this already.
  if (planBridge) planBridge.toggle = toggle
  return (
    <ul
      className={styles['stickyPlanBar']}
      data-testid="acp-plan-bar"
      data-timeline-key={PLAN_SLOT_KEY}
      onClick={() => onFocusSlot?.(PLAN_SLOT_KEY)}
    >
      <PlanCard
        entries={entries}
        collapsed={collapsed}
        onToggle={toggle}
        rootProps={{
          // The focus ring goes on the card (inset from the chat edge), not the
          // full-width <ul> — same geometry as the sticky first-user bar.
          className: `${styles['planCard'] ?? ''}${focused ? ` ${styles['timelineSlotFocused']}` : ''}`,
        }}
      />
    </ul>
  )
}
