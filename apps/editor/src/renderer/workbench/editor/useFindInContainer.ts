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
  matches: readonly DomMatch[],
  currentIndex: number,
  hlAll: string,
  hlCurrent: string,
): void {
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
  api.registry.set(hlAll, all)
  api.registry.set(hlCurrent, current)
}

function clearHighlights(hlAll: string, hlCurrent: string): void {
  const api = highlightApi()
  if (!api) return
  api.registry.delete(hlAll)
  api.registry.delete(hlCurrent)
}

function reveal(match: DomMatch | undefined): void {
  match?.node.parentElement?.scrollIntoView({ block: 'nearest' })
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
      applyHighlights(found, idx, hlAll, hlCurrent)
      if (doReveal && idx >= 0) reveal(found[idx])
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
    clearHighlights(hlAll, hlCurrent)
    matchesRef.current = []
    setCount(0)
    setCurrentIndex(-1)
    setQueryState('')
  }, [hlAll, hlCurrent])

  const move = useCallback(
    (delta: number) => {
      const found = matchesRef.current
      if (found.length === 0) return
      const idx = (currentIndexRef.current + delta + found.length) % found.length
      currentIndexRef.current = idx
      setCurrentIndex(idx)
      applyHighlights(found, idx, hlAll, hlCurrent)
      reveal(found[idx])
    },
    [hlAll, hlCurrent],
  )

  const next = useCallback(() => move(1), [move])
  const prev = useCallback(() => move(-1), [move])
  const setQuery = useCallback((q: string) => setQueryState(q), [])

  return { visible, query, count, currentIndex, open, close, setQuery, next, prev }
}
