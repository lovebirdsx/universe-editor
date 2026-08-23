/*---------------------------------------------------------------------------------------------
 *  FocusScopeOverlay — thin wrapper around @react-aria/focus's FocusScope that
 *  encapsulates the standard popover/dialog focus contract:
 *    - autoFocus:    move focus into the overlay on mount
 *    - contain:      trap Tab/Shift+Tab inside the overlay
 *    - restoreFocus: on unmount, return focus to whatever held it before mount
 *
 *  Use this for QuickInput, Dialog, Popover — anywhere that conceptually steals
 *  focus from the underlying workbench Part and must restore it on close.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, type ReactNode } from 'react'
import { FocusScope } from '@react-aria/focus'

export interface FocusScopeOverlayProps {
  /** Render the overlay only while visible. Toggling this drives restoreFocus. */
  visible: boolean
  /** Optional Escape handler — keeps the contract co-located with the trap. */
  onEscape?: () => void
  children: ReactNode
}

export function FocusScopeOverlay({ visible, onEscape, children }: FocusScopeOverlayProps) {
  useEffect(() => {
    if (!visible || !onEscape) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Floating UI popups (Select, ContextMenu…) render in a body-level portal
      // outside this scope and register their own document listener after ours,
      // so Escape aimed at an open popup must not also close the overlay. A
      // mouse-opened popup leaves focus on its trigger, which floating-ui marks
      // with aria-controls pointing at the portalled popup.
      const target = e.target as Element | null
      if (target?.closest?.('[data-floating-ui-portal]')) return
      const controls = target?.getAttribute?.('aria-controls')
      if (controls && document.getElementById(controls)?.closest('[data-floating-ui-portal]')) {
        return
      }
      onEscape()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [visible, onEscape])

  if (!visible) return null
  return (
    <FocusScope contain restoreFocus autoFocus>
      {children}
    </FocusScope>
  )
}
