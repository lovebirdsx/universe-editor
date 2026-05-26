/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionsPopover — Copilot-style dropdown for the sidebar Chat panel. Wraps
 *  SessionListBody with absolute positioning + outside-click dismissal. Picking
 *  a row both kicks off the resume and asks the parent to collapse the popover.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { RefreshCw } from 'lucide-react'
import { useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { SessionListBody } from './SessionListBody.js'
import styles from './agents.module.css'

export interface SessionsPopoverProps {
  onDismiss: () => void
}

export function SessionsPopover({ onDismiss }: SessionsPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const service = useService(IAcpSessionService)
  const [refreshing, setRefreshing] = useState(false)

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
        <button
          type="button"
          className={styles['toolbarButton']}
          onClick={handleRefresh}
          disabled={refreshing}
          data-testid="acp-refresh-sessions-popover"
          title={localize('acp.refreshSessions', 'Refresh session list')}
          aria-label={localize('acp.refreshSessions', 'Refresh session list')}
        >
          <span aria-hidden="true">
            <RefreshCw
              size={14}
              strokeWidth={1.75}
              className={refreshing ? styles['spin'] : undefined}
            />
          </span>
        </button>
      </div>
      <SessionListBody onPick={() => onDismiss()} />
    </div>
  )
}
