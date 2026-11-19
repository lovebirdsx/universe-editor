/*---------------------------------------------------------------------------------------------
 *  FocusScopeOverlay — thin wrapper around @react-aria/focus's FocusScope that
 *  encapsulates the standard popover/dialog focus contract:
 *    - autoFocus:    move focus into the overlay on mount
 *    - contain:      trap Tab/Shift+Tab inside the overlay
 *    - restoreFocus: on close, return focus to whatever held it when the overlay
 *                    became visible
 *
 *  The restore target is captured once per visible session (false→true render)
 *  and stays read-only afterwards: cleanup must not consume it, because in dev
 *  StrictMode replays setup→cleanup→setup for newly mounted components. The
 *  restore is deferred one microtask so a cleanup immediately followed by a
 *  re-setup (the rehearsal) restores nothing, while a real close still hands
 *  focus back to the pre-overlay element.
 *
 *  Use this for QuickInput, Dialog, Popover — anywhere that conceptually steals
 *  focus from the underlying workbench Part and must restore it on close.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type ReactNode } from 'react'
import { FocusScope } from '@react-aria/focus'
import { isHTMLElementLike } from '../dom/domRealm.js'
import { useOwnerDocument } from './ownerDocumentContext.js'

export interface FocusScopeOverlayProps {
  /** Render the overlay only while visible. Toggling this drives restoreFocus. */
  visible: boolean
  /** Optional Escape handler — keeps the contract co-located with the trap. */
  onEscape?: () => void
  /** Document hosting the overlay (an auxiliary workbench window). */
  targetDocument?: Document | undefined
  /**
   * Optional gate for the unmount restore. Without it focus is always restored;
   * with it, returning false leaves focus wherever it went. QuickInput uses this
   * to avoid yanking focus back after an accepted item revealed an editor in
   * another window (react-aria restores after the pick handler already moved it).
   */
  shouldRestoreFocus?: (() => boolean) | undefined
  children: ReactNode
}

export function FocusScopeOverlay({
  visible,
  onEscape,
  targetDocument,
  shouldRestoreFocus,
  children,
}: FocusScopeOverlayProps) {
  const doc = useOwnerDocument(targetDocument)
  // react-aria seeds its restore target during render from the *global*
  // document; inside an auxiliary window that would be the main window's active
  // element. Use the document-aware restore below whenever the overlay is not
  // hosted by the main document, not just when a caller supplies a gate.
  const ownsRestore =
    shouldRestoreFocus !== undefined ||
    (doc !== undefined && (typeof document === 'undefined' || doc !== document))
  const conditionRef = useRef(shouldRestoreFocus)
  conditionRef.current = shouldRestoreFocus

  // Captured during render: react-aria's autoFocus runs in the child's layout
  // effect, which would already point at the overlay's own input by the time
  // this component's effects run.
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wasVisibleRef = useRef(false)
  if (visible && !wasVisibleRef.current) {
    const active = doc?.activeElement
    previousFocusRef.current = isHTMLElementLike(active) ? active : null
  }
  wasVisibleRef.current = visible

  // A fresh session id per effect setup lets a deferred restore notice that a
  // newer setup (StrictMode's rehearsal re-setup) superseded it. The object is
  // stable; only its counter changes.
  const sessionStateRef = useRef({ session: 0 })
  useEffect(() => {
    if (!visible || !ownsRestore) return
    const sessionState = sessionStateRef.current
    const session = ++sessionState.session
    return () => {
      // Restore on the next microtask and only if no setup superseded this
      // cleanup. StrictMode's mount rehearsal runs cleanup→setup synchronously;
      // restoring there would fire spurious focus/context-key events (and steal
      // focus from the child autoFocus that reclaims it right after). The
      // snapshot itself is read-only so the real close still has it.
      queueMicrotask(() => {
        if (sessionState.session !== session) return
        if (conditionRef.current?.() === false) return
        const previous = previousFocusRef.current
        if (previous?.isConnected) previous.focus()
      })
    }
    // `conditionRef` keeps the predicate out of the deps: an inline arrow would
    // otherwise re-run this effect (and restore focus) on every render.
  }, [visible, doc, ownsRestore])

  useEffect(() => {
    if (!visible || !onEscape || !doc) return
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
      if (controls && doc.getElementById(controls)?.closest('[data-floating-ui-portal]')) {
        return
      }
      onEscape()
    }
    doc.addEventListener('keydown', handler)
    return () => doc.removeEventListener('keydown', handler)
  }, [visible, onEscape, doc])

  if (!visible) return null
  return (
    <FocusScope contain restoreFocus={!ownsRestore} autoFocus>
      {children}
    </FocusScope>
  )
}
