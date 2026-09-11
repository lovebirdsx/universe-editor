/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  rendererHeapReporter — pushes the renderer's own heap watermark to main.
 *
 *  The renderer is the only observer of its V8 heap, and `processMetrics.log` is written
 *  by main. Without this hop the heap curve dies with the process it describes: the crash
 *  packages behind this file had a working-set line every 30 seconds and nothing at all
 *  about the heap that actually ran out — which is ~93% `lo_space`, i.e. giant strings.
 *  Hence `holders`: "the heap was 3GB" is a symptom, "the heap was 3GB and ACP held 2.1GB
 *  of it" is a lead.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { IDiagnosticsService, WireHeapHolder } from '../../../shared/ipc/services.js'
import {
  MEMORY_PRESSURE_LEVEL_NAMES,
  type MemoryPressureLevel,
  type MemorySample,
} from './memoryPressureLevels.js'

/** One slice of the renderer heap that already tracks how much it holds. */
export interface HeapHolderSource {
  readonly name: string
  /** Overhead-adjusted bytes, or undefined when the holder is not loaded at all. */
  measure(): { bytes: number; count?: number } | undefined
}

export function collectHeapHolders(sources: readonly HeapHolderSource[]): WireHeapHolder[] {
  const holders: WireHeapHolder[] = []
  for (const source of sources) {
    try {
      const measured = source.measure()
      if (!measured || !Number.isFinite(measured.bytes) || measured.bytes <= 0) continue
      holders.push({
        name: source.name,
        bytes: measured.bytes,
        ...(measured.count === undefined ? {} : { count: measured.count }),
      })
    } catch {
      // Attribution is best-effort: a holder that cannot be measured must not cost the
      // heap reading itself, which is the part that cannot be recovered later.
    }
  }
  return holders
}

/**
 * Fire-and-forget on purpose — a rejected report must not disturb the sampler. That
 * makes the failure silent by construction (the IPC surface only rejects on a wiring
 * mistake, and a missing service throws on property access), so it is logged exactly
 * once: a broken hop repeats every 30 seconds forever, and one line saying so is what
 * separates "the curve is missing from this report" from "this build had no curve".
 * `smoke.memoryPressure.spec.ts` asserts the line reaches main, which is the other half.
 *
 * The service is resolved lazily: this reporter is built while the sampler is, which is
 * before the proxy-channel services exist, and the first reading is seconds away anyway.
 */
export function createRendererHeapReporter(
  getDiagnostics: () => IDiagnosticsService,
  sources: readonly HeapHolderSource[],
  logger?: ILogger,
): (sample: MemorySample, level: MemoryPressureLevel) => void {
  let failureLogged = false
  const failed = (err: unknown): void => {
    if (failureLogged) return
    failureLogged = true
    logger?.warn(`[memory] heap report failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return (sample, level) => {
    try {
      void getDiagnostics()
        .reportRendererHeapSample({
          used: sample.used,
          limit: sample.limit,
          level: MEMORY_PRESSURE_LEVEL_NAMES[level],
          holders: collectHeapHolders(sources),
        })
        .catch(failed)
    } catch (err) {
      failed(err)
    }
  }
}
