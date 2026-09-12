/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The renderer's only cheap proxy for Blink-side memory: how many DOM nodes exist.
 *
 *  On 2026-09-12 a growing code fence was re-tokenized on every frame, replacing its
 *  whole <code> subtree each time; ~800MB of DOM and layout objects piled up outside
 *  the V8 heap, where `performance.memory` cannot see them. Node count is what moves
 *  when that happens, and it costs one live-collection length read.
 *
 *  Takes the document as an argument so the sampling stays testable without a DOM.
 *--------------------------------------------------------------------------------------------*/

import { setHeapGauge } from './heapFlowCounters.js'
import { MemoryPressureLevel } from './memoryPressureLevels.js'

export function sampleDomGauges(doc: Document, level: MemoryPressureLevel): void {
  // The walk is O(nodes) and normal readings are 30s apart, so paying for it there puts
  // a periodic main-thread hitch on every window to produce a number nothing reads until
  // something is already wrong.
  if (level === MemoryPressureLevel.Normal) return
  setHeapGauge('domnodes', doc.getElementsByTagName('*').length)
}
