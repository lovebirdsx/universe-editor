/*---------------------------------------------------------------------------------------------
 *  FocusScopeOverlay — thin wrapper around @react-aria/focus's FocusScope that
 *  encapsulates the standard popover/dialog focus contract:
 *    - autoFocus:    move focus into the overlay on mount
 *    - contain:      trap Tab/Shift+Tab inside the overlay
 *    - restoreFocus: on close, return focus to whatever held it when the overlay
 *                    became visible
 *
 *  The restore half is the shared `useFocusRestore` contract (capture in the
 *  visible false→true render, read-only cleanup, a microtask + session counter
 *  so dev StrictMode's rehearsal restores nothing). Keep both in sync through
 *  that hook rather than re-implementing the snapshot here.
 *
 *  Use this for QuickInput, Dialog, Popover — anywhere that conceptually steals
 *  focus from the underlying workbench Part and must restore it on close.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, type ReactNode } from 'react'
import { FocusScope } from '@react-aria/focus'
import { useFocusRestore } from './focusRestore.js'
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

  useFocusRestore(visible, {
    targetDocument: doc,
    shouldRestore: () => ownsRestore && (shouldRestoreFocus?.() ?? true),
  })

  useDocumentEscape(visible, onEscape, doc)

  if (!visible) return null
  return (
    <FocusScope contain restoreFocus={!ownsRestore} autoFocus>
      {children}
    </FocusScope>
  )
}

function useDocumentEscape(
  visible: boolean,
  onEscape: (() => void) | undefined,
  doc: Document | undefined,
): void {
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
}
