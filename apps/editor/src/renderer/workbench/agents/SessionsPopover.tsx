/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionsPopover — Copilot-style dropdown for the sidebar Chat panel. Wraps
 *  SessionListBody with absolute positioning + outside-click dismissal. Picking
 *  a row both kicks off the resume and asks the parent to collapse the popover.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { localize } from '@universe-editor/platform'
import { SessionListBody } from './SessionListBody.js'
import styles from './agents.module.css'

export interface SessionsPopoverProps {
  onDismiss: () => void
}

export function SessionsPopover({ onDismiss }: SessionsPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

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
      <SessionListBody onPick={() => onDismiss()} disableOpenInEditor />
    </div>
  )
}
