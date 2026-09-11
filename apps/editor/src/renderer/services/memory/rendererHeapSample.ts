/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads the renderer's own V8 heap watermark.
 *
 *  Chromium exposes `performance.memory` in renderers but it is not part of lib.dom, and
 *  the guard below is written so this module stays importable from the plain-node test
 *  project (no DOM globals required) — the sampling unit tests inject their own reader.
 *--------------------------------------------------------------------------------------------*/

import type { MemorySample } from './memoryPressureLevels.js'

interface ChromiumMemoryInfo {
  readonly usedJSHeapSize: number
  readonly totalJSHeapSize: number
  readonly jsHeapSizeLimit: number
}

type PerformanceWithMemory = { readonly memory?: ChromiumMemoryInfo }

/**
 * Returns undefined rather than a zeroed sample when the API is missing, so callers can
 * tell "no observation" apart from "nothing in use" — a watermark service that guessed
 * in that case would be worse than one that admits it is blind.
 */
export function readHeapSample(): MemorySample | undefined {
  if (typeof performance === 'undefined') return undefined
  const memory = (performance as PerformanceWithMemory).memory
  if (!memory) return undefined
  const used = memory.usedJSHeapSize
  if (!Number.isFinite(used) || used <= 0) return undefined
  const limit = memory.jsHeapSizeLimit
  return { used, limit: Number.isFinite(limit) && limit > 0 ? limit : 0 }
}
