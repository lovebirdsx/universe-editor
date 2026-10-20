/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentNavBar — the floating `‹ 2/5 ›` pill above the chat timeline. It walks
 *  the top-level sub-agent cards via the same widget command Alt+Shift+J/K uses
 *  and tracks the viewport so the counter follows manual scrolling. Kept separate
 *  from ChatBody's own subscriptions so streaming timeline updates re-render only
 *  this small pill (and only when the displayed index actually changes).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { localize } from '@universe-editor/platform'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import type { WidgetHandle } from './ChatBody.js'
import { currentSubagentIndex, topLevelSubagentCards } from './subagentNavigation.js'
import styles from './agents.module.css'

interface SubagentNavBarProps {
  readonly session: IAcpSession
  readonly scrollContainerRef: MutableRefObject<HTMLDivElement | null>
  readonly handleRef: MutableRefObject<WidgetHandle>
}

export function SubagentNavBar({ session, scrollContainerRef, handleRef }: SubagentNavBarProps) {
  const timeline = useObservable(session.timeline)
  const cards = useMemo(() => topLevelSubagentCards(timeline), [timeline])
  const [active, setActive] = useState(-1)

  // Shared with ChatBody's moveSubagent, so the number shown here and the place
  // the arrows jump from can never disagree after a manual scroll. Reading the
  // focused key through the handle keeps this component off ChatBody's render path.
  const recompute = useCallback(() => {
    if (cards.length === 0) {
      setActive((prev) => (prev === -1 ? prev : -1))
      return
    }
    const next = currentSubagentIndex(
      cards,
      timeline,
      handleRef.current.getFocusedKey(),
      scrollContainerRef.current,
    )
    setActive((prev) => (prev === next ? prev : next))
  }, [cards, scrollContainerRef, handleRef, timeline])

  // Callbacks below run from listeners that outlive timeline updates, so they go
  // through this ref instead of re-subscribing on every streaming transaction.
  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute

  const rafRef = useRef<number | undefined>(undefined)
  const schedule = useCallback(() => {
    if (rafRef.current !== undefined) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      recomputeRef.current()
    })
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    schedule()
    container.addEventListener('scroll', schedule, { passive: true })
    // Collapsing a card above the viewport and resizing the pane both move rows
    // without a scroll event; the collapse bridge covers Alt+F / Ctrl+Alt+F and
    // the observer covers split-view resizes.
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(container)
    const timelineEl = container.querySelector('[data-testid="acp-timeline"]')
    if (timelineEl) observer?.observe(timelineEl)
    const collapseSub = handleRef.current.onDidChangeCollapse(schedule)
    return () => {
      container.removeEventListener('scroll', schedule)
      observer?.disconnect()
      collapseSub.dispose()
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = undefined
      }
    }
  }, [scrollContainerRef, handleRef, schedule, session.id])

  // The ordinal only changes when a card is added/removed; streaming tokens and
  // their auto-stick scrolls are handled by the listener above, so a long turn
  // never triggers a DOM scan per transaction.
  useEffect(() => {
    schedule()
  }, [schedule, cards.length])

  useEffect(() => {
    const sub = handleRef.current.onDidChangeFocusedKey(schedule)
    return () => sub.dispose()
  }, [handleRef, schedule])

  if (cards.length === 0) return null

  const total = cards.length
  const position =
    active < 0
      ? localize('acp.subagentNav.positionUnknown', '–/{total}', { total })
      : localize('acp.subagentNav.position', '{index}/{total}', {
          index: active + 1,
          total,
        })

  return (
    <div className={styles['subagentNav']} data-testid="acp-subagent-nav">
      <button
        type="button"
        className={styles['subagentNavBtn']}
        data-testid="acp-subagent-prev"
        data-tooltip={localize('acp.subagentNav.previous', 'Previous sub-agent card')}
        aria-label={localize('acp.subagentNav.previous', 'Previous sub-agent card')}
        disabled={active === 0}
        onClick={() => handleRef.current.moveSubagent('prev')}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <span className={styles['subagentNavCount']} data-testid="acp-subagent-count">
        {position}
      </span>
      <button
        type="button"
        className={styles['subagentNavBtn']}
        data-testid="acp-subagent-next"
        data-tooltip={localize('acp.subagentNav.next', 'Next sub-agent card')}
        aria-label={localize('acp.subagentNav.next', 'Next sub-agent card')}
        disabled={active === total - 1}
        onClick={() => handleRef.current.moveSubagent('next')}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
