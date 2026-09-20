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
  /**
   * Sub-agent publishes, counted apart from `materialize` (which is the top-level
   * path). The two streams have different batch deadlines and different render
   * paths, and a package that cannot say which one dominated cannot be acted on —
   * the 2026-09-12 crash had both available and no way to tell them apart.
   */
  'childchunks',
  /** 文档镜像发往扩展宿主的载荷：`docpush` 是真正上线的字符数，`docdrop` 是被丢弃的增量（超上限、
   *  批失败、或被整篇推送取代）。docdrop 升而 docpush 降=上限在起作用，两者同升=放大器还在赢。 */
  'docpush',
  'docdrop',
  /** 外部刷新从盘上读回来的字符数：一次读盘的代价是同一份内容在传输、解码、最小编辑扫描上各来
   *  一遍，且随文件持续变更反复发生——涨的 `extreload` 是与 `docpush` 并排读时才分得开的读侧成本。 */
  'extreload',
] as const
export type HeapFlowName = (typeof HEAP_FLOW_NAMES)[number]

/**
 * Absolute readings of process-wide singletons, where last-writer-wins is correct
 * because there is exactly one of each.
 */
export const HEAP_GAUGE_NAMES = ['domnodes'] as const

/**
 * Absolute readings summed across every mounted MarkdownView.
 *
 * Summed rather than last-writer-wins: with several chat panels open, the view that
 * rendered last is not the one holding the window's markdown, and the reading exists
 * to answer "how much markdown is this window carrying" — the question the 2026-09-12
 * crash left unanswerable, since a last-writer-wins gauge reports one view's worth no
 * matter how many are alive.
 */
export const HEAP_VIEW_GAUGE_NAMES = [
  'views',
  'astnodes',
  'sealednodes',
  'tailchars',
  'mdbytes',
] as const

export type HeapGaugeName =
  | (typeof HEAP_GAUGE_NAMES)[number]
  | (typeof HEAP_VIEW_GAUGE_NAMES)[number]
/** Only the singleton gauges are settable directly; the rest come from views. */
export type HeapSingletonGaugeName = (typeof HEAP_GAUGE_NAMES)[number]

export interface HeapFlowSnapshot {
  readonly name: HeapFlowName
  readonly calls: number
  readonly chars: number
}

export interface HeapGaugeSnapshot {
  readonly name: HeapGaugeName
  readonly value: number
}

/** What one mounted MarkdownView is holding. */
export interface HeapViewGauges {
  readonly astnodes: number
  readonly sealednodes: number
  readonly tailchars: number
  /** Source characters, i.e. sealed prefix + tail. */
  readonly mdbytes: number
}

const flowCalls = new Map<HeapFlowName, number>()
const flowChars = new Map<HeapFlowName, number>()
const totalCalls = new Map<HeapFlowName, number>()
const totalChars = new Map<HeapFlowName, number>()
const gauges = new Map<HeapSingletonGaugeName, number>()
const viewGauges = new Map<number, HeapViewGauges>()

let nextViewId = 1
let codeHtmlBytes = 0

export function bumpHeapFlow(name: HeapFlowName, chars: number): void {
  const counted = Number.isFinite(chars) && chars > 0 ? chars : 0
  flowCalls.set(name, (flowCalls.get(name) ?? 0) + 1)
  flowChars.set(name, (flowChars.get(name) ?? 0) + counted)
  totalCalls.set(name, (totalCalls.get(name) ?? 0) + 1)
  totalChars.set(name, (totalChars.get(name) ?? 0) + counted)
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

/**
 * Same counters, never cleared — process totals a second observer can difference.
 *
 * `drainHeapFlow` is destructive, so its readings only work for one consumer. The
 * heap sampler is that consumer and it drains every 5 seconds; a spec sharing that
 * counter would silently lose whatever a sample happened to take first, which is
 * exactly what made `smoke.agentStreamMemory` pass locally (a ~600ms stream fits
 * between two samples) and report `mdparse.calls: 1` on a contended CI runner.
 * Monotonic totals are immune: take one reading before and one after, subtract.
 */
export function readHeapFlowTotals(): readonly HeapFlowSnapshot[] {
  const snapshots: HeapFlowSnapshot[] = []
  for (const name of HEAP_FLOW_NAMES) {
    const calls = totalCalls.get(name) ?? 0
    if (calls === 0) continue
    snapshots.push({ name, calls, chars: totalChars.get(name) ?? 0 })
  }
  return snapshots
}

export function setHeapGauge(name: HeapSingletonGaugeName, value: number): void {
  gauges.set(name, Number.isFinite(value) && value >= 0 ? value : 0)
}

/**
 * Register one mounted view's readings and return its handle. Views come and go with
 * the chat panels, so a flat accumulator would drift the moment one unmounts without
 * the exact numbers it registered with; a keyed table cannot.
 *
 * A view that re-renders with new numbers re-registers under a fresh handle rather
 * than updating in place — that is what `MarkdownView`'s memoised gauges object makes
 * its effect do — so there is deliberately no update path to keep in step.
 */
export function registerHeapView(gauges: HeapViewGauges): number {
  const id = nextViewId++
  viewGauges.set(id, gauges)
  return id
}

export function unregisterHeapView(id: number): void {
  viewGauges.delete(id)
}

export function readHeapGauges(): readonly HeapGaugeSnapshot[] {
  const snapshots: HeapGaugeSnapshot[] = []
  for (const name of HEAP_GAUGE_NAMES) {
    const value = gauges.get(name) ?? 0
    if (value === 0) continue
    snapshots.push({ name, value })
  }
  const summed = new Map<string, number>()
  // Not a sum: how many views are mounted is itself the reading, and it is what says
  // whether a per-view total is describing one panel or a dozen.
  if (viewGauges.size > 0) summed.set('views', viewGauges.size)
  for (const view of viewGauges.values()) {
    for (const name of HEAP_VIEW_GAUGE_NAMES) {
      if (name === 'views') continue
      summed.set(name, (summed.get(name) ?? 0) + view[name])
    }
  }
  for (const name of HEAP_VIEW_GAUGE_NAMES) {
    const value = summed.get(name) ?? 0
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
