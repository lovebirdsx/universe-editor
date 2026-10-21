/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useFindInContainer — generic in-container find state machine. Owns find-bar
 *  visibility, query, match set and current index, and drives the highlight
 *  overlay via the CSS Custom Highlight API (no DOM mutation).
 *
 *  Matches are collected by walking the live container's text nodes (TreeWalker
 *  SHOW_TEXT), spanning inline elements for free. Elements with [data-find-widget]
 *  are excluded from the walk so the find bar itself never matches its own text.
 *
 *  CSS.highlights / Highlight are Chromium 130+ (Electron 33) APIs; every call
 *  site feature-detects and no-ops under tests (happy-dom doesn't implement them).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { getOwnerWindow } from '@universe-editor/workbench-ui'
import { computeMatches } from '../../services/acp/chatFindMatcher.js'

interface DomMatch {
  readonly node: Text
  readonly start: number
  readonly end: number
}

interface HighlightLike {
  add(range: Range): void
}
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}
type HighlightCtor = new () => HighlightLike

/**
 * Highlight registry and constructor from the container's own window. An
 * auxiliary window has its own `CSS.highlights`; writing a range into the main
 * window's registry renders nothing there and leaves the main document's
 * registry holding ranges it can never paint.
 */
function highlightApi(node: Node | null | undefined):
  | {
      registry: HighlightRegistryLike
      Highlight: HighlightCtor
    }
  | undefined {
  const win = getOwnerWindow(node) as
    | (Window & {
        CSS?: { highlights?: HighlightRegistryLike }
        Highlight?: HighlightCtor
      })
    | undefined
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: HighlightCtor
  }
  // Both halves must come from the same realm: a Highlight created by window A
  // written into window B's registry silently paints nothing.
  const ownerRegistry = win?.CSS?.highlights
  const ownerCtor = win?.Highlight
  if (ownerRegistry && ownerCtor) return { registry: ownerRegistry, Highlight: ownerCtor }
  const globalRegistry = g.CSS?.highlights
  const globalCtor = g.Highlight
  if (globalRegistry && globalCtor) return { registry: globalRegistry, Highlight: globalCtor }
  return undefined
}

function collectMatches(root: HTMLElement, query: string): DomMatch[] {
  const out: DomMatch[] = []
  if (query.length === 0) return out
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-find-widget]')) return NodeFilter.FILTER_REJECT
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

function applyHighlights(
  root: Node,
  matches: readonly DomMatch[],
  currentIndex: number,
  hlAll: string,
  hlCurrent: string,
): HighlightRegistryLike | undefined {
  const api = highlightApi(root)
  if (!api) return undefined
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
  api.registry.set(hlAll, all)
  api.registry.set(hlCurrent, current)
  return api.registry
}

function clearHighlights(
  registry: HighlightRegistryLike | undefined,
  hlAll: string,
  hlCurrent: string,
): void {
  registry?.delete(hlAll)
  registry?.delete(hlCurrent)
}

// Reveal the current match centered in the container. We only scroll when the
// match isn't already fully in view, so navigating between matches that already
// share the viewport doesn't jump the scroll position around; when a scroll is
// needed we center it (block: 'center') instead of nudging it to the nearest
// edge, which used to leave the new match pinned to the bottom with almost no
// context around it.
function reveal(root: HTMLElement, match: DomMatch | undefined): void {
  const el = match?.node.parentElement
  if (!el) return
  const containerRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const fullyVisible = elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom
  if (fullyVisible) return
  el.scrollIntoView({ block: 'center' })
}

export interface FindInContainerState {
  readonly visible: boolean
  readonly query: string
  readonly count: number
  readonly currentIndex: number
  open(): void
  close(): void
  setQuery(query: string): void
  next(): void
  prev(): void
}

export interface FindInContainerOptions {
  readonly hlAll: string
  readonly hlCurrent: string
}

export function useFindInContainer<T extends HTMLElement>(
  containerRef: MutableRefObject<T | null>,
  contentSignature: unknown,
  options: FindInContainerOptions,
  onVisibleChange: (open: boolean) => void,
): FindInContainerState {
  const { hlAll, hlCurrent } = options

  const [visible, setVisible] = useState(false)
  const [query, setQueryState] = useState('')
  const [count, setCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(-1)

  const matchesRef = useRef<DomMatch[]>([])
  /** Registry the current highlights were written into (owner of the container). */
  const registryRef = useRef<HighlightRegistryLike | undefined>(undefined)
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
      const registry = applyHighlights(root, found, idx, hlAll, hlCurrent)
      // An elementary "container adopted into another document" path would
      // otherwise leave the old registry holding ranges forever.
      if (registry !== registryRef.current) clearHighlights(registryRef.current, hlAll, hlCurrent)
      registryRef.current = registry
      if (doReveal && idx >= 0) reveal(root, found[idx])
    },
    [containerRef, query, hlAll, hlCurrent],
  )

  useLayoutEffect(() => {
    if (!visible) return
    scan(true, true)
  }, [visible, scan])

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
    clearHighlights(registryRef.current, hlAll, hlCurrent)
    registryRef.current = undefined
    matchesRef.current = []
    setCount(0)
    setCurrentIndex(-1)
    setQueryState('')
  }, [hlAll, hlCurrent])

  // Unmount without close (editor moved/closed) must drop the ranges too.
  useLayoutEffect(
    () => () => clearHighlights(registryRef.current, hlAll, hlCurrent),
    [hlAll, hlCurrent],
  )

  const move = useCallback(
    (delta: number) => {
      const found = matchesRef.current
      if (found.length === 0) return
      const idx = (currentIndexRef.current + delta + found.length) % found.length
      currentIndexRef.current = idx
      setCurrentIndex(idx)
      const root = containerRef.current
      // Container unmounted mid-navigation: fall back to a match's own document.
      const anchor = root ?? found[0]?.node
      if (anchor) registryRef.current = applyHighlights(anchor, found, idx, hlAll, hlCurrent)
      if (root) reveal(root, found[idx])
    },
    [containerRef, hlAll, hlCurrent],
  )

  const next = useCallback(() => move(1), [move])
  const prev = useCallback(() => move(-1), [move])
  const setQuery = useCallback((q: string) => setQueryState(q), [])

  return { visible, query, count, currentIndex, open, close, setQuery, next, prev }
}
