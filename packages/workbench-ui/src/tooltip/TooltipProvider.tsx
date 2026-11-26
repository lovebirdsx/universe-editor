/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  TooltipProvider — the single tooltip surface for the whole workbench.
 *  A global event delegation replaces the native `title` attribute: any element
 *  carrying `data-tooltip="…"` gets a themed tooltip after a hover/focus delay.
 *  Elements carrying a plain `title` attribute (Monaco hover links, third-party
 *  widgets, stray JSX) get the same themed tooltip instead of the OS-native one:
 *  the attribute is stashed while hovered (suppressing the native bubble) and
 *  restored afterwards so accessibility tooling still sees it.
 *  Rendered through Floating UI anchored to the element (top, flipping below when
 *  there is no room), styled by tooltipSurface.module.css so it matches the rest
 *  of the overlay family (menu / dialog / popover).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react'
import { isElementLike, isNodeLike } from '../dom/domRealm.js'
import { useOwnerDocument } from '../overlay/ownerDocumentContext.js'
import {
  TOOLTIP_ATTRIBUTE,
  TOOLTIP_COMMAND_ATTRIBUTE,
  TOOLTIP_HOST_SELECTOR,
  claimNativeTitle,
  restoreNativeTitle,
  tooltipTextFrom,
} from './tooltipAttributes.js'
import {
  registerKeyboardTooltipController,
  type KeyboardTooltipRequest,
} from './keyboardTooltip.js'
import styles from './tooltipSurface.module.css'

export { TOOLTIP_ATTRIBUTE, TOOLTIP_COMMAND_ATTRIBUTE }

const REOPEN_WINDOW_MS = 200
const FOCUS_SUPPRESS_AFTER_MOUSEDOWN_MS = 350
const DETACHED_CHECK_INTERVAL_MS = 500

type PointerTooltipSource = 'mouse' | 'focus'

interface TooltipState {
  target: Element
  text: string
  /** How the tooltip was requested; mouseouts only dismiss pointer-driven ones. */
  source: PointerTooltipSource | 'keyboard'
  /** Row anchoring a keyboard tooltip; polled for selection loss. */
  row?: Element | undefined
}

export interface TooltipProviderProps {
  /** Hover/focus delay in ms before the tooltip appears. Defaults to 500. */
  delay?: number
  /**
   * Host-injected keybinding resolver for {@link TOOLTIP_COMMAND_ATTRIBUTE}
   * hosts: given a command id, return its effective keybinding label
   * ("Ctrl+Shift+E") or undefined when unbound.
   */
  resolveShortcut?: ((commandId: string) => string | undefined) | undefined
  /** Document this provider delegates for (auxiliary workbench windows). */
  targetDocument?: Document | undefined
  children?: ReactNode
}

function tooltipTargetFrom(
  node: EventTarget | null,
  resolveShortcut?: (commandId: string) => string | undefined,
): { target: Element; text: string } | null {
  if (!isElementLike(node)) return null
  const el = node.closest(TOOLTIP_HOST_SELECTOR)
  if (!el) return null
  // A native `title` on the resolved element would pop the OS bubble alongside
  // ours — claim it even when `data-tooltip` wins the text.
  claimNativeTitle(el)
  const text = tooltipTextFrom(el, resolveShortcut)
  return text ? { target: el, text } : null
}

export function TooltipProvider({
  delay = 500,
  resolveShortcut,
  targetDocument,
  children,
}: TooltipProviderProps) {
  const doc = useOwnerDocument(targetDocument)
  const [tip, setTip] = useState<TooltipState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipRef = useRef<TooltipState | null>(null)
  const pendingRef = useRef<{ target: Element; source: PointerTooltipSource } | null>(null)
  const lastHideAtRef = useRef(0)
  const lastMouseDownAtRef = useRef(0)
  /** Reaches the effect-scoped hide() from the selection-polling effect. */
  const hideTooltipRef = useRef<() => void>(() => undefined)
  /**
   * A keyboard stroke that opens a tooltip may also reach this provider's own
   * keydown listener when Vim did not claim it; skip exactly that stroke.
   */
  const skipNextKeyDownRef = useRef(false)

  tipRef.current = tip

  useEffect(() => {
    if (doc === undefined) return
    const clear = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      pendingRef.current = null
    }
    const hide = () => {
      clear()
      if (tipRef.current !== null) {
        restoreNativeTitle(tipRef.current.target)
        lastHideAtRef.current = Date.now()
      }
      setTip(null)
    }
    hideTooltipRef.current = hide
    const show = (next: { target: Element; text: string }, source: PointerTooltipSource) => {
      clear()
      // Chain behavior: while a tooltip is visible (or just dismissed), moving to
      // another tooltip host shows it instantly instead of waiting out the delay.
      // Nested hosts (parent/child both titled) switch without a mouseout, so the
      // previous host's native title is restored here rather than in hide().
      const instant =
        tipRef.current !== null || Date.now() - lastHideAtRef.current < REOPEN_WINDOW_MS
      if (tipRef.current !== null && tipRef.current.target !== next.target) {
        restoreNativeTitle(tipRef.current.target)
      }
      if (instant) {
        setTip({ ...next, source })
      } else {
        pendingRef.current = { target: next.target, source }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          pendingRef.current = null
          // Re-read the attribute at fire time: hosts may fill in the text
          // asynchronously (e.g. lazy-fetched content) during the delay.
          setTip({ ...(tooltipTargetFrom(next.target, resolveShortcut) ?? next), source })
        }, delay)
      }
    }

    // -- keyboard-triggered tooltips (Vim K on a list row) --------------------
    const hideKeyboard = () => {
      if (tipRef.current?.source === 'keyboard') hide()
    }
    const showKeyboard = (request: KeyboardTooltipRequest) => {
      if (request.target.isConnected === false) return
      const text = tooltipTextFrom(request.target, resolveShortcut)
      if (text === '') return
      claimNativeTitle(request.target)
      clear()
      if (tipRef.current !== null && tipRef.current.target !== request.target) {
        restoreNativeTitle(tipRef.current.target)
      }
      // This runs from the command dispatched by the stroke; do not let the
      // provider's own keydown listener dismiss the tip we just opened.
      skipNextKeyDownRef.current = true
      queueMicrotask(() => {
        skipNextKeyDownRef.current = false
      })
      setTip({
        target: request.target,
        text,
        source: 'keyboard',
        ...(request.row !== undefined ? { row: request.row } : {}),
      })
    }
    const refreshKeyboard = () => {
      const current = tipRef.current
      if (current === null || current.source !== 'keyboard') return
      if (current.target.isConnected === false) {
        hide()
        return
      }
      const text = tooltipTextFrom(current.target, resolveShortcut)
      if (text === '') {
        hide()
        return
      }
      if (text !== current.text) setTip({ ...current, text })
    }
    const keyboardController = registerKeyboardTooltipController(doc, {
      show: showKeyboard,
      hide: hideKeyboard,
      refresh: refreshKeyboard,
    })

    const onMouseOver = (e: MouseEvent) => {
      const next = tooltipTargetFrom(e.target, resolveShortcut)
      if (!next) return
      if (tipRef.current?.target === next.target && tipRef.current.text === next.text) return
      show(next, 'mouse')
    }
    const onMouseOut = (e: MouseEvent) => {
      const current = tipRef.current
      if (!current) {
        // Window activation can synthesize a mouseout on body during the delay;
        // only the pointer leaving the pending hover target cancels a show.
        const pending = pendingRef.current
        if (pending?.source !== 'mouse') return
        const left = e.target
        if (isNodeLike(left) && (left === pending.target || pending.target.contains(left))) {
          clear()
        }
        return
      }
      // Keyboard-driven tooltips are dismissed by the next stroke / focusout /
      // Escape / mousedown, not by the pointer moving somewhere else.
      if (current.source !== 'mouse') return
      const movingTo = e.relatedTarget
      if (isNodeLike(movingTo) && current.target.contains(movingTo)) return
      hide()
    }
    const onFocusIn = (e: FocusEvent) => {
      // Clicking focuses the element too; the mouse handlers own that scenario.
      if (Date.now() - lastMouseDownAtRef.current < FOCUS_SUPPRESS_AFTER_MOUSEDOWN_MS) return
      const next = tooltipTargetFrom(e.target, resolveShortcut)
      if (next) show(next, 'focus')
    }
    const onFocusOut = () => hide()
    const onMouseDown = () => {
      lastMouseDownAtRef.current = Date.now()
      hide()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide()
        return
      }
      const current = tipRef.current
      if (current?.source !== 'keyboard') return
      if (skipNextKeyDownRef.current) {
        skipNextKeyDownRef.current = false
        return
      }
      // Any later stroke means the user is moving on; drop the keyboard tip.
      hide()
    }

    doc.addEventListener('mouseover', onMouseOver)
    doc.addEventListener('mouseout', onMouseOut)
    doc.addEventListener('focusin', onFocusIn)
    doc.addEventListener('focusout', onFocusOut)
    doc.addEventListener('mousedown', onMouseDown, true)
    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('scroll', hide, true)
    doc.addEventListener('wheel', hide, true)
    return () => {
      clear()
      // Drop the current tip with the document it was anchored to; a doc change
      // must not leave the old portal content behind.
      hide()
      keyboardController.dispose()
      doc.removeEventListener('mouseover', onMouseOver)
      doc.removeEventListener('mouseout', onMouseOut)
      doc.removeEventListener('focusin', onFocusIn)
      doc.removeEventListener('focusout', onFocusOut)
      doc.removeEventListener('mousedown', onMouseDown, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      doc.removeEventListener('scroll', hide, true)
      doc.removeEventListener('wheel', hide, true)
    }
  }, [delay, resolveShortcut, doc])

  // The host element can be unmounted by React while its tooltip is visible
  // (list re-render, tree collapse, …) — no mouseout fires in that case. A
  // keyboard tooltip additionally follows a virtual cursor: close it when its
  // row loses the selection, so programmatic focus moves do not leave it behind.
  useEffect(() => {
    if (!tip) return
    const id = setInterval(() => {
      if (!tip.target.isConnected) {
        hideTooltipRef.current()
        return
      }
      if (tip.source !== 'keyboard') return
      const row = tip.row
      if (row !== undefined && row.isConnected && row.getAttribute('aria-selected') === 'false') {
        hideTooltipRef.current()
      }
    }, DETACHED_CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [tip])

  return (
    <>
      {children}
      {tip ? <TooltipSurface target={tip.target} text={tip.text} targetDocument={doc} /> : null}
    </>
  )
}

function TooltipSurface({
  target,
  text,
  targetDocument,
}: Pick<TooltipState, 'target' | 'text'> & { targetDocument: Document | undefined }) {
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'top',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  useEffect(() => {
    refs.setReference(target)
  }, [refs, target])

  return (
    <FloatingPortal root={targetDocument?.body ?? target.ownerDocument.body}>
      <div
        ref={refs.setFloating}
        role="tooltip"
        className={styles['tooltipSurface']}
        style={floatingStyles}
      >
        {text}
      </div>
    </FloatingPortal>
  )
}
