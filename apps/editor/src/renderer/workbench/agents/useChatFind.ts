/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useChatFind — the in-session find state machine for ChatScroll. Owns the
 *  find-bar visibility, query, match set and current index, and drives the
 *  highlight overlay via the CSS Custom Highlight API (no DOM mutation, so it
 *  never fights React's reconciliation of the rendered markdown).
 *
 *  Matches are collected by walking the live container's text nodes (TreeWalker
 *  SHOW_TEXT), so highlighting follows the rendered, user-visible text and spans
 *  inline elements (`<strong>` / `<code>` / colorized token spans) for free.
 *  ChatScroll disables virtualization while find is open so the walk covers the
 *  whole session, not just the rows in the overscan window.
 *
 *  CSS.highlights / Highlight are Chromium 130+ (Electron 33) APIs that happy-dom
 *  does not implement; every call site feature-detects and no-ops under tests.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { computeMatches } from '../../services/acp/chatFindMatcher.js'
import './chatFindHighlight.css'

const HL_ALL = 'acp-find-match'
const HL_CURRENT = 'acp-find-match-current'

interface DomMatch {
  readonly node: Text
  readonly start: number
  readonly end: number
}

// Local, defensive types for the CSS Custom Highlight API so typecheck does not
// depend on the lib.dom version shipping the Highlight definitions.
interface HighlightLike {
  add(range: Range): void
}
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}
type HighlightCtor = new () => HighlightLike

function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightCtor } | undefined {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: HighlightCtor
  }
  const registry = g.CSS?.highlights
  const Highlight = g.Highlight
  if (!registry || !Highlight) return undefined
  return { registry, Highlight }
}

function collectMatches(root: HTMLElement, query: string): DomMatch[] {
  const out: DomMatch[] = []
  if (query.length === 0) return out
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-acp-find-widget]')) return NodeFilter.FILTER_REJECT
      const value = node.nodeValue
      return value && value.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const value = text.nodeValue ?? ''
    for (const m of computeMatches(value, query)) {
      out.push({ node: text, start: m.start, end: m.end })
    }
  }
  return out
}

function applyHighlights(matches: readonly DomMatch[], currentIndex: number): void {
  const api = highlightApi()
  if (!api) return
  const all = new api.Highlight()
  const current = new api.Highlight()
  matches.forEach((m, i) => {
    const range = m.node.ownerDocument.createRange()
    try {
      range.setStart(m.node, m.start)
      range.setEnd(m.node, m.end)
    } catch {
      return
    }
    ;(i === currentIndex ? current : all).add(range)
  })
  api.registry.set(HL_ALL, all)
  api.registry.set(HL_CURRENT, current)
}

function clearHighlights(): void {
  const api = highlightApi()
  if (!api) return
  api.registry.delete(HL_ALL)
  api.registry.delete(HL_CURRENT)
}

function reveal(match: DomMatch | undefined): void {
  match?.node.parentElement?.scrollIntoView({ block: 'nearest' })
}

export interface ChatFind {
  readonly visible: boolean
  readonly query: string
  readonly count: number
  /** 0-based index of the current match; -1 when there are none. */
  readonly currentIndex: number
  open(): void
  close(): void
  setQuery(query: string): void
  next(): void
  prev(): void
}

/**
 * @param containerRef the scroll container to search within.
 * @param contentSignature a value that changes whenever timeline content grows
 *   (streaming chunks / new messages); triggers a re-scan that keeps the user's
 *   current match instead of jumping back to the first.
 * @param onVisibleChange reports open/closed up so ChatScroll can de-virtualize
 *   and push `acpChatFindVisible` through the widget service.
 */
export function useChatFind<T extends HTMLElement>(
  containerRef: MutableRefObject<T | null>,
  contentSignature: unknown,
  onVisibleChange: (open: boolean) => void,
): ChatFind {
  const [visible, setVisible] = useState(false)
  const [query, setQueryState] = useState('')
  const [count, setCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(-1)

  const matchesRef = useRef<DomMatch[]>([])
  const currentIndexRef = useRef(-1)
  currentIndexRef.current = currentIndex
  const onVisibleChangeRef = useRef(onVisibleChange)
  onVisibleChangeRef.current = onVisibleChange

  const scan = useCallback(
    (resetIndex: boolean, doReveal: boolean) => {
      const root = containerRef.current
      if (!root) return
      const found = collectMatches(root, query)
      matchesRef.current = found
      setCount(found.length)
      let idx: number
      if (found.length === 0) idx = -1
      else if (resetIndex) idx = 0
      else idx = Math.min(Math.max(currentIndexRef.current, 0), found.length - 1)
      currentIndexRef.current = idx
      setCurrentIndex(idx)
      applyHighlights(found, idx)
      if (doReveal && idx >= 0) reveal(found[idx])
    },
    [containerRef, query],
  )

  // Open / query change → re-scan from the first match. A layout effect so the
  // de-virtualized full list has mounted (visible flipped → ChatScroll renders
  // the plain <ol>) before we walk the DOM.
  useLayoutEffect(() => {
    if (!visible) return
    scan(true, true)
  }, [visible, scan])

  // Streaming / timeline growth → re-scan but keep the user's current match and
  // don't yank the viewport. Intentionally keyed on contentSignature alone:
  // open / query changes are handled by the effect above (which resets to the
  // first match), so this one only reacts to content mutating underneath.
  useLayoutEffect(() => {
    if (!visible) return
    scan(false, false)
  }, [contentSignature])

  const open = useCallback(() => {
    setVisible(true)
    onVisibleChangeRef.current(true)
  }, [])

  const close = useCallback(() => {
    setVisible(false)
    onVisibleChangeRef.current(false)
    clearHighlights()
    matchesRef.current = []
    setCount(0)
    setCurrentIndex(-1)
    setQueryState('')
  }, [])

  const move = useCallback((delta: number) => {
    const found = matchesRef.current
    if (found.length === 0) return
    const idx = (currentIndexRef.current + delta + found.length) % found.length
    currentIndexRef.current = idx
    setCurrentIndex(idx)
    applyHighlights(found, idx)
    reveal(found[idx])
  }, [])

  const next = useCallback(() => move(1), [move])
  const prev = useCallback(() => move(-1), [move])
  const setQuery = useCallback((q: string) => setQueryState(q), [])

  return { visible, query, count, currentIndex, open, close, setQuery, next, prev }
}
