/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownLinkHints — vimium-style keyboard link navigation for the markdown
 *  preview. Press the trigger key, every visible link gets a short overlaid
 *  label; type the label to follow that link. `inNewTab` (Shift+F) follows it to
 *  the side, mirroring a Ctrl/Cmd+click.
 *
 *  Activation re-dispatches a synthetic `click` on the target <a>, so all of the
 *  preview's existing link routing (external URL / file: / file-path / inline
 *  code) is reused verbatim — no opening logic is duplicated here. While hints
 *  are showing the hook owns the keyboard at the capture phase, so letters filter
 *  labels instead of reaching the page.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { DEFAULT_HINT_CHARS, generateHintLabels } from './markdownLinkHints.js'

export interface LinkHintMarker {
  readonly label: string
  /** Viewport coordinates (the overlay is position:fixed). */
  readonly left: number
  readonly top: number
  readonly el: HTMLAnchorElement
}

export interface MarkdownLinkHintsState {
  readonly active: boolean
  readonly typed: string
  /** Markers still matching the typed prefix (what the overlay renders). */
  readonly markers: readonly LinkHintMarker[]
  show(inNewTab: boolean): void
  hide(): void
}

function collectVisibleLinks(root: HTMLElement): HTMLAnchorElement[] {
  const containerRect = root.getBoundingClientRect()
  const out: HTMLAnchorElement[] = []
  for (const a of root.querySelectorAll('a[href]')) {
    if (!(a instanceof HTMLAnchorElement)) continue
    const r = a.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    // Keep only links whose box intersects the visible scroll viewport.
    if (
      r.bottom <= containerRect.top ||
      r.top >= containerRect.bottom ||
      r.right <= containerRect.left ||
      r.left >= containerRect.right
    ) {
      continue
    }
    out.push(a)
  }
  return out
}

function activate(el: HTMLAnchorElement, inNewTab: boolean): void {
  el.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: inNewTab,
      metaKey: inNewTab,
    }),
  )
}

export function useMarkdownLinkHints<T extends HTMLElement>(
  rootRef: MutableRefObject<T | null>,
): MarkdownLinkHintsState {
  const [active, setActive] = useState(false)
  const [typed, setTyped] = useState('')
  const [markers, setMarkers] = useState<readonly LinkHintMarker[]>([])

  // Mirror render state into refs so the capture-phase listener (registered once
  // per activation) always reads current values without re-subscribing.
  const allMarkersRef = useRef<readonly LinkHintMarker[]>([])
  const typedRef = useRef('')
  const inNewTabRef = useRef(false)

  const hide = useCallback(() => {
    setActive(false)
    setTyped('')
    setMarkers([])
    allMarkersRef.current = []
    typedRef.current = ''
  }, [])

  const show = useCallback(
    (inNewTab: boolean) => {
      const root = rootRef.current
      if (!root) return
      const links = collectVisibleLinks(root)
      if (links.length === 0) return
      const labels = generateHintLabels(links.length, DEFAULT_HINT_CHARS)
      const containerRect = root.getBoundingClientRect()
      const next: LinkHintMarker[] = links.map((el, i) => {
        const r = el.getBoundingClientRect()
        return {
          label: labels[i] ?? '',
          left: Math.max(r.left, containerRect.left),
          top: Math.max(r.top, containerRect.top),
          el,
        }
      })
      inNewTabRef.current = inNewTab
      allMarkersRef.current = next
      typedRef.current = ''
      setMarkers(next)
      setTyped('')
      setActive(true)
    },
    [rootRef],
  )

  // Own the keyboard while hints are showing: letters filter, Backspace pops,
  // Escape (and any non-hint key) dismisses. Capture phase so editor keybindings
  // never see these keys.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        hide()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        const next = typedRef.current.slice(0, -1)
        typedRef.current = next
        setTyped(next)
        return
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
      const ch = e.key.toLowerCase()
      if (!DEFAULT_HINT_CHARS.includes(ch)) {
        // A key outside the hint alphabet cancels the mode (vimium behaviour).
        e.preventDefault()
        e.stopPropagation()
        hide()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const next = typedRef.current + ch
      const matches = allMarkersRef.current.filter((m) => m.label.startsWith(next))
      if (matches.length === 0) {
        hide()
        return
      }
      if (matches.length === 1) {
        const target = matches[0]!.el
        const inNewTab = inNewTabRef.current
        hide()
        activate(target, inNewTab)
        return
      }
      typedRef.current = next
      setTyped(next)
      setMarkers(matches)
    }

    // Stale positions are worse than no hints: dismiss on scroll/resize/blur.
    const dismiss = (): void => hide()
    document.addEventListener('keydown', onKeyDown, true)
    const root = rootRef.current
    root?.addEventListener('scroll', dismiss, { passive: true })
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      root?.removeEventListener('scroll', dismiss)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [active, hide, rootRef])

  return { active, typed, markers, show, hide }
}
