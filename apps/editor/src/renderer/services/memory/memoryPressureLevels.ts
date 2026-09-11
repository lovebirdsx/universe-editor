/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure watermark maths for the renderer heap. Kept free of DOM / Electron so it can be
 *  unit-tested in the node project (see memoryPressureService for the sampler).
 *
 *  Calibration point: a shipped renderer died at `heap.used = 3.85GB` against the 4GB
 *  main cage, with GC reclaiming 0.0MB — the heap was almost entirely live. The lines
 *  below sit well under that so there is room to release caches and pause background
 *  work while the user can still be told what happened.
 *--------------------------------------------------------------------------------------------*/

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export enum MemoryPressureLevel {
  Normal = 0,
  Elevated = 1,
  Critical = 2,
}

export interface MemorySample {
  readonly used: number
  readonly limit: number
}

export interface MemoryThresholds {
  readonly elevated: number
  readonly critical: number
}

/**
 * `jsHeapSizeLimit` is not reliable in every configuration (an injected
 * `--max-old-space-size`, an isolate variant that reports 0). Below this it is
 * discarded in favour of the 4GB pointer-compression cage Electron actually ships.
 */
export const MIN_TRUSTED_LIMIT_BYTES = 512 * MIB

/** Fallback heap limit: the V8 main cage size observed in the shipped crash dump. */
export const ASSUMED_HEAP_LIMIT_BYTES = 4 * GIB

const ELEVATED_RATIO = 0.45
const ELEVATED_FLOOR_BYTES = 1.5 * GIB
const ELEVATED_CEILING_RATIO = 0.5
const CRITICAL_RATIO = 0.68
const CRITICAL_FLOOR_BYTES = 2.5 * GIB
const CRITICAL_CEILING_RATIO = 0.85

/**
 * Absolute floor as the rule, the limit ratio as the backstop — and the ratio also caps
 * the floor. Both directions matter: the floor keeps a misreported-too-large limit from
 * delaying the release past the point of no return, while the ceiling keeps a
 * misreported-too-small limit from parking the threshold above the heap it is meant to
 * protect (which would mean never firing at all).
 */
export function resolveMemoryThresholds(limit: number): MemoryThresholds {
  const trusted =
    Number.isFinite(limit) && limit >= MIN_TRUSTED_LIMIT_BYTES ? limit : ASSUMED_HEAP_LIMIT_BYTES
  return {
    elevated: Math.min(
      Math.max(ELEVATED_FLOOR_BYTES, ELEVATED_RATIO * trusted),
      ELEVATED_CEILING_RATIO * trusted,
    ),
    critical: Math.min(
      Math.max(CRITICAL_FLOOR_BYTES, CRITICAL_RATIO * trusted),
      CRITICAL_CEILING_RATIO * trusted,
    ),
  }
}

/**
 * A drop must clear the level's line by this margin before we call it relieved. Without
 * it a heap hovering on a threshold would flap between releasing (which frees and drops
 * the reading) and idle (which climbs back), re-running every releaser each cycle.
 */
export const PRESSURE_HYSTERESIS = 0.85

/** Watermark for `sample`, given the level currently in effect. */
export function evaluatePressure(
  sample: MemorySample,
  previous: MemoryPressureLevel,
  thresholds: MemoryThresholds,
): MemoryPressureLevel {
  const { used } = sample
  const target =
    used >= thresholds.critical
      ? MemoryPressureLevel.Critical
      : used >= thresholds.elevated
        ? MemoryPressureLevel.Elevated
        : MemoryPressureLevel.Normal
  if (target >= previous) return target
  if (
    previous === MemoryPressureLevel.Critical &&
    used >= thresholds.critical * PRESSURE_HYSTERESIS
  ) {
    return MemoryPressureLevel.Critical
  }
  if (
    previous === MemoryPressureLevel.Elevated &&
    used >= thresholds.elevated * PRESSURE_HYSTERESIS
  ) {
    return MemoryPressureLevel.Elevated
  }
  return target
}

export const MEMORY_PRESSURE_LEVEL_NAMES: Readonly<Record<MemoryPressureLevel, string>> = {
  [MemoryPressureLevel.Normal]: 'normal',
  [MemoryPressureLevel.Elevated]: 'elevated',
  [MemoryPressureLevel.Critical]: 'critical',
}
