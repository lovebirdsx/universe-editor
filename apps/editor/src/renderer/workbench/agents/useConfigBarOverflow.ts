/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useConfigBarOverflow — measures the config bar's entries against the width
 *  of their single line and greedily moves the low-priority tail into an
 *  overflow set (priority = entry order, see configBarLayout.ts). The entries
 *  stay mounted (overflowed ones only leave the flex line via CSS), so their
 *  natural offsetWidths remain measurable without clone hacks.
 *
 *  The ResizeObserver watches the items container AND every entry element: a
 *  container-only observer misses entry growth when --agent-font-size changes
 *  (the bar width stays the same while the entries get wider). Callbacks are
 *  batched through requestAnimationFrame, and the returned Set keeps its
 *  reference while its contents stay equal so a resize storm cannot loop.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { splitConfigBarOverflow, type ConfigBarEntry } from '../../services/acp/configBarLayout.js'

const EMPTY: ReadonlySet<string> = new Set()

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

export function useConfigBarOverflow(entries: readonly ConfigBarEntry[]): {
  readonly itemsRef: React.RefObject<HTMLDivElement | null>
  readonly overflowRef: React.RefObject<HTMLButtonElement | null>
  readonly entryRefFor: (key: string) => (el: HTMLElement | null) => void
  readonly overflowedKeys: ReadonlySet<string>
} {
  const itemsRef = useRef<HTMLDivElement | null>(null)
  const overflowRef = useRef<HTMLButtonElement | null>(null)
  const entryElsRef = useRef(new Map<string, HTMLElement>())
  const [overflowedKeys, setOverflowedKeys] = useState<ReadonlySet<string>>(EMPTY)

  // `entries` is rebuilt on every render (buildConfigBarEntries sorts a copy),
  // so the keys are memoized through a serialized signature to keep `measure`
  // (and the observer effect below) stable across unrelated re-renders.
  const keysSignature = useMemo(() => JSON.stringify(entries.map((e) => e.key)), [entries])
  const keys = useMemo(() => JSON.parse(keysSignature) as string[], [keysSignature])
  // `measure` stays stable so every ResizeObserver callback (and any rAF
  // already queued for this frame) runs the same function — one queued with the
  // previous entry set must not overwrite state with stale keys. The ref is
  // synced in the layout phase, before the observer effect re-measures.
  const keysRef = useRef(keys)
  useLayoutEffect(() => {
    keysRef.current = keys
  }, [keys])

  const entryRefFor = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) entryElsRef.current.set(key, el)
      else entryElsRef.current.delete(key)
    },
    [],
  )

  const measure = useCallback(() => {
    const items = itemsRef.current
    if (!items) return
    const gap = parseFloat(getComputedStyle(items).columnGap) || 0
    // The ... button stays mounted (hidden via CSS when there is no overflow),
    // so its width can always be reserved by the packing.
    const buttonWidth = overflowRef.current?.offsetWidth ?? 0
    const widthOf = (key: string): number => entryElsRef.current.get(key)?.offsetWidth ?? 0
    const next = splitConfigBarOverflow(
      keysRef.current,
      widthOf,
      items.clientWidth,
      buttonWidth,
      gap,
    )
    setOverflowedKeys((prev) => (sameSet(prev, next) ? prev : next))
  }, [])

  useLayoutEffect(() => {
    const items = itemsRef.current
    if (!items) return
    // First measurement before paint so the bar never flashes its two-line
    // fallback; entries are re-measured here too whenever the entry set
    // changes (options arriving async, switching agents).
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    ro.observe(items)
    for (const el of entryElsRef.current.values()) ro.observe(el)
    if (overflowRef.current) ro.observe(overflowRef.current)
    return () => ro.disconnect()
  }, [measure, keys])

  return { itemsRef, overflowRef, entryRefFor, overflowedKeys }
}
