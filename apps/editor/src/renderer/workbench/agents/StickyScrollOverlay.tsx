/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StickyScrollOverlay — VSCode-style sticky scroll for the chat timeline. Pins
 *  the header(s) of whichever card(s) the viewport's top line is currently inside
 *  to the top of the scroll area, stacking nested sub-agent cards below their
 *  parent. Each pinned header can fold its card (chevron) or jump back to the
 *  card's top (title). Lives as the first child of the chatBody scroll container
 *  with zero height so it never shifts the content; the inner stack is absolutely
 *  positioned and only the headers themselves capture pointer events.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AcpChildItem, TimelineItem } from '../../services/acp/acpSession.js'
import { ToolCallStatusIcon } from './ToolCallOutput.js'
import { roleIcon, toolKindIcon } from './timelineIcons.js'
import {
  computeStickyStack,
  findByStickyKey,
  type CardRect,
  type StickyEntry,
} from './stickyScroll.js'
import { resolveCollapsed, type CollapseState } from './timelineCollapse.js'
import styles from './agents.module.css'

const DEPTH_INDENT_PX = 14
const SUMMARY_MAX = 120

interface StickyScrollOverlayProps {
  readonly containerRef: MutableRefObject<HTMLDivElement | null>
  readonly timeline: readonly TimelineItem[]
  readonly collapse: CollapseState
  readonly onToggleCollapse: (key: string) => void
  readonly onJumpTo: (key: string) => void
  /** Bumped by the parent (virtualize / length / tail) to force a re-measure. */
  readonly revision: unknown
}

export function StickyScrollOverlay({
  containerRef,
  timeline,
  collapse,
  onToggleCollapse,
  onJumpTo,
  revision,
}: StickyScrollOverlayProps) {
  const [entries, setEntries] = useState<StickyEntry[]>([])
  const rafRef = useRef<number | undefined>(undefined)

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      setEntries((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const cRect = container.getBoundingClientRect()
    const scrollTop = container.scrollTop
    const rects: CardRect[] = []
    container.querySelectorAll<HTMLElement>('[data-sticky-key]').forEach((node) => {
      const key = node.dataset['stickyKey']
      if (key === undefined) return
      // The card's own header is the first matching descendant — it always
      // precedes the body (and thus any nested card's header) in DOM order.
      const headerBtn = node.querySelector<HTMLElement>(
        'button[data-testid="acp-collapsible-toggle"]',
      )
      if (!headerBtn) return
      const headerHeight = headerBtn.getBoundingClientRect().height
      if (headerHeight <= 0) return
      const r = node.getBoundingClientRect()
      rects.push({
        key,
        depth: Number(node.dataset['stickyDepth'] ?? '0'),
        top: r.top - cRect.top + scrollTop,
        bottom: r.bottom - cRect.top + scrollTop,
        headerHeight,
      })
    })
    const next = computeStickyStack(rects, scrollTop, container.clientHeight)
    setEntries((prev) => (sameStack(prev, next) ? prev : next))
  }, [containerRef])

  const schedule = useCallback(() => {
    if (rafRef.current !== undefined) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined
      measure()
    })
  }, [measure])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    measure()
    container.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(container)
    // Observe the content wrapper (last child; the overlay itself is the first)
    // so async growth — Monaco colorizing, images decoding, streaming tails —
    // re-measures the sticky stack.
    const content = container.lastElementChild
    if (content) ro.observe(content)
    return () => {
      container.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      rafRef.current = undefined
    }
  }, [containerRef, schedule, measure])

  // Geometry shifts when the timeline grows, the collapse state changes, or the
  // render mode flips — re-measure (rAF-throttled).
  useEffect(() => {
    schedule()
  }, [timeline, collapse, revision, schedule])

  return (
    <div className={styles['stickyOverlay']} aria-hidden="true">
      <div className={styles['stickyStack']}>
        {entries.map((e) => {
          const item = findByStickyKey(timeline, e.key)
          if (!item) return null
          const collapsed = resolveCollapsed(e.key, item, collapse)
          return (
            <StickyHeader
              key={e.key}
              entry={e}
              item={item}
              collapsed={collapsed}
              onToggle={() => onToggleCollapse(e.key)}
              onJump={() => onJumpTo(e.key)}
            />
          )
        })}
      </div>
    </div>
  )
}

function StickyHeader({
  entry,
  item,
  collapsed,
  onToggle,
  onJump,
}: {
  entry: StickyEntry
  item: TimelineItem | AcpChildItem
  collapsed: boolean
  onToggle: () => void
  onJump: () => void
}) {
  const { icon, text, status, label } = headerContent(item)
  return (
    <div
      className={styles['stickyHeaderWrap']}
      style={{ transform: `translateY(${entry.translateY}px)`, zIndex: 100 - entry.depth }}
    >
      <div
        className={styles['stickyCard']}
        style={{ marginLeft: entry.depth * DEPTH_INDENT_PX }}
        data-testid="acp-sticky-header"
        data-sticky-key-active={entry.key}
      >
        <button
          type="button"
          className={styles['stickyTitleBtn']}
          onClick={onJump}
          title={label}
          data-testid="acp-sticky-jump"
        >
          <span className={styles['stickyIcon']} aria-hidden="true">
            {icon}
          </span>
          <span className={styles['stickyTitleText']}>{text}</span>
        </button>
        {status}
        <button
          type="button"
          className={styles['stickyChevronBtn']}
          aria-expanded={!collapsed}
          onClick={onToggle}
          title="Collapse"
          data-testid="acp-sticky-toggle"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
    </div>
  )
}

interface HeaderContent {
  icon: React.ReactNode
  text: string
  status: React.ReactNode
  label: string
}

function headerContent(item: TimelineItem | AcpChildItem): HeaderContent {
  if (item.kind === 'message') {
    return {
      icon: roleIcon(item.message.role),
      text: clampLine(item.message.text) || item.message.role,
      status: null,
      label: item.message.role,
    }
  }
  return {
    icon: toolKindIcon(item.call.kind),
    text: item.call.title,
    status: <ToolCallStatusIcon status={item.call.status} />,
    label: item.call.kind,
  }
}

function clampLine(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine
}

function sameStack(a: readonly StickyEntry[], b: readonly StickyEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.key !== y.key ||
      x.depth !== y.depth ||
      Math.round(x.translateY) !== Math.round(y.translateY)
    )
      return false
  }
  return true
}
