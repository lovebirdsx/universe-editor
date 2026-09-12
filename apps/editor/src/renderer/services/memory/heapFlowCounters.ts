/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Counters for the work a renderer does between two heap samples.
 *
 *  `performance.memory` sees only the main isolate's JS heap. On 2026-09-12 a
 *  renderer grew by ~800MB the heap curve did not show — DOM and layout objects
 *  from re-tokenizing a growing code fence on every frame — so the reading that
 *  outlived the process said "the heap is small" while it sat past 2GB. Measuring
 *  the work that produces such memory is what makes a repeat attributable.
 *--------------------------------------------------------------------------------------------*/

/** Work done since the previous sample: bump per occurrence, read-then-clear. */
export const HEAP_FLOW_NAMES = [
  'mdparse',
  'mdreseal',
  'colorize',
  'colorize.skip',
  'materialize',
] as const
export type HeapFlowName = (typeof HEAP_FLOW_NAMES)[number]

/**
 * Absolute readings, not deltas. `domnodes` is the only cheap proxy the renderer
 * has for Blink-side memory, which is where off-heap growth actually lands; the
 * rest describe how much markdown the live views are carrying.
 */
export const HEAP_GAUGE_NAMES = ['domnodes', 'astnodes', 'sealednodes', 'tailchars'] as const
export type HeapGaugeName = (typeof HEAP_GAUGE_NAMES)[number]

export interface HeapFlowSnapshot {
  readonly name: HeapFlowName
  readonly calls: number
  readonly chars: number
}

export interface HeapGaugeSnapshot {
  readonly name: HeapGaugeName
  readonly value: number
}

const flowCalls = new Map<HeapFlowName, number>()
const flowChars = new Map<HeapFlowName, number>()
const gauges = new Map<HeapGaugeName, number>()

let codeHtmlBytes = 0

export function bumpHeapFlow(name: HeapFlowName, chars: number): void {
  flowCalls.set(name, (flowCalls.get(name) ?? 0) + 1)
  flowChars.set(
    name,
    (flowChars.get(name) ?? 0) + (Number.isFinite(chars) && chars > 0 ? chars : 0),
  )
}

/**
 * Only entries that saw activity: a line naming five counters when one did work
 * buries the one that matters. The counters reset here, so each reading describes
 * its own interval rather than the process lifetime.
 */
export function drainHeapFlow(): readonly HeapFlowSnapshot[] {
  const snapshots: HeapFlowSnapshot[] = []
  for (const name of HEAP_FLOW_NAMES) {
    const calls = flowCalls.get(name) ?? 0
    if (calls === 0) continue
    snapshots.push({ name, calls, chars: flowChars.get(name) ?? 0 })
    flowCalls.set(name, 0)
    flowChars.set(name, 0)
  }
  return snapshots
}

export function setHeapGauge(name: HeapGaugeName, value: number): void {
  gauges.set(name, Number.isFinite(value) && value >= 0 ? value : 0)
}

export function readHeapGauges(): readonly HeapGaugeSnapshot[] {
  const snapshots: HeapGaugeSnapshot[] = []
  for (const name of HEAP_GAUGE_NAMES) {
    const value = gauges.get(name) ?? 0
    if (value === 0) continue
    snapshots.push({ name, value })
  }
  return snapshots
}

/**
 * Colorized HTML held by mounted code blocks. Counted by the blocks themselves on
 * a UTF-16 basis, the same conservative scale the monaco holder uses — the point
 * is the trend against the heap reading, not the exact byte count.
 */
export function addCodeHtmlBytes(delta: number): void {
  if (!Number.isFinite(delta)) return
  codeHtmlBytes = Math.max(0, codeHtmlBytes + delta)
}

export function readCodeHtmlBytes(): number {
  return codeHtmlBytes
}
