/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionsPopover — Copilot-style dropdown for the sidebar Chat panel. Wraps
 *  SessionListBody with absolute positioning + outside-click dismissal. Picking
 *  a row both kicks off the resume and asks the parent to collapse the popover.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { Filter, RefreshCw, Search } from 'lucide-react'
import { IconButton } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpSessionFilterService } from '../../services/acp/acpSessionFilterService.js'
import { SessionListBody } from './SessionListBody.js'
import { SessionsFilterPopover } from './SessionsFilterPopover.js'
import styles from './agents.module.css'

export interface SessionsPopoverProps {
  onDismiss: () => void
}

export function SessionsPopover({ onDismiss }: SessionsPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const service = useService(IAcpSessionService)
  const filterService = useService(IAcpSessionFilterService)
  const searchOpen = useObservable(filterService.searchOpen)
  const filterDefault = useObservable(filterService.isFilterDefault)
  const [refreshing, setRefreshing] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  const handleRefresh = (e: ReactMouseEvent) => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    void service.refreshSessions().finally(() => setRefreshing(false))
  }

  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    // Defer one tick so the click that opened the popover doesn't immediately
    // close it (the open click bubbles into document before our handler attaches).
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={containerRef}
      className={styles['sessionsPopover']}
      data-testid="acp-sessions-popover"
      role="listbox"
      aria-label={localize('acp.sessions.popover', 'Sessions')}
    >
      <div className={styles['sessionsPopoverToolbar']}>
        <IconButton
          label={localize('acp.sessions.search', 'Search sessions')}
          active={searchOpen}
          onClick={() => filterService.toggleSearch()}
          data-testid="acp-session-search-popover"
        >
          <Search size={14} strokeWidth={1.75} />
        </IconButton>
        <span className={styles['filterAnchor']}>
          <IconButton
            label={localize('acp.filter.menu', 'Filter sessions')}
            active={filterOpen || !filterDefault}
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            aria-haspopup="menu"
            data-testid="acp-session-filter-popover"
          >
            <Filter size={14} strokeWidth={1.75} />
          </IconButton>
          {filterOpen && <SessionsFilterPopover onDismiss={() => setFilterOpen(false)} />}
        </span>
        <IconButton
          label={localize('acp.refreshSessions', 'Refresh session list')}
          onClick={handleRefresh}
          disabled={refreshing}
          data-testid="acp-refresh-sessions-popover"
        >
          <RefreshCw
            size={14}
            strokeWidth={1.75}
            className={refreshing ? styles['spin'] : undefined}
          />
        </IconButton>
      </div>
      <SessionListBody onPick={() => onDismiss()} />
    </div>
  )
}
