/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ASSUMED_HEAP_LIMIT_BYTES,
  MEMORY_PRESSURE_LEVEL_NAMES,
  MemoryPressureLevel,
  evaluatePressure,
  resolveMemoryThresholds,
} from '../memoryPressureLevels.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

describe('resolveMemoryThresholds', () => {
  it('keeps the critical line under the shipped cage and below the crash point', () => {
    const t = resolveMemoryThresholds(4 * GIB)
    expect(t.elevated).toBeGreaterThan(GIB)
    expect(t.critical).toBeGreaterThan(t.elevated)
    // The observed fatal heap was 3.85GB — the critical line must leave room above it.
    expect(t.critical).toBeLessThan(3.85 * GIB)
  })

  it('always orders elevated below critical', () => {
    for (const limit of [0, 256 * MIB, GIB, 2 * GIB, 3 * GIB, 4 * GIB, 8 * GIB, Number.NaN]) {
      const t = resolveMemoryThresholds(limit)
      expect(t.elevated).toBeLessThan(t.critical)
    }
  })

  it('falls back to the assumed cage when the limit is untrustworthy', () => {
    expect(resolveMemoryThresholds(0)).toEqual(resolveMemoryThresholds(ASSUMED_HEAP_LIMIT_BYTES))
    expect(resolveMemoryThresholds(Number.NaN)).toEqual(
      resolveMemoryThresholds(ASSUMED_HEAP_LIMIT_BYTES),
    )
    expect(resolveMemoryThresholds(64 * MIB)).toEqual(
      resolveMemoryThresholds(ASSUMED_HEAP_LIMIT_BYTES),
    )
  })

  it('scales down with a small limit instead of parking above it', () => {
    const t = resolveMemoryThresholds(4 * GIB)
    const small = resolveMemoryThresholds(2 * GIB)
    expect(small.critical).toBeLessThan(t.critical)
    expect(small.critical).toBeLessThan(2 * GIB)
  })
})

describe('evaluatePressure', () => {
  const thresholds = resolveMemoryThresholds(4 * GIB)
  const at = (used: number, previous: MemoryPressureLevel) =>
    evaluatePressure({ used, limit: 4 * GIB }, previous, thresholds)

  it('escalates as soon as a line is crossed', () => {
    expect(at(thresholds.elevated - 1, MemoryPressureLevel.Normal)).toBe(MemoryPressureLevel.Normal)
    expect(at(thresholds.elevated, MemoryPressureLevel.Normal)).toBe(MemoryPressureLevel.Elevated)
    expect(at(thresholds.critical, MemoryPressureLevel.Normal)).toBe(MemoryPressureLevel.Critical)
  })

  it('jumps straight to critical without passing through elevated', () => {
    expect(at(thresholds.critical, MemoryPressureLevel.Normal)).toBe(MemoryPressureLevel.Critical)
  })

  it('holds the level inside the hysteresis band so a hover does not flap', () => {
    const justBelow = thresholds.critical - 1
    expect(at(justBelow, MemoryPressureLevel.Critical)).toBe(MemoryPressureLevel.Critical)
    expect(at(thresholds.elevated, MemoryPressureLevel.Elevated)).toBe(MemoryPressureLevel.Elevated)
  })

  it('relieves only once the drop clears the margin', () => {
    expect(at(thresholds.critical * 0.85, MemoryPressureLevel.Critical)).toBe(
      MemoryPressureLevel.Critical,
    )
    expect(at(thresholds.critical * 0.85 - 1, MemoryPressureLevel.Critical)).toBe(
      MemoryPressureLevel.Elevated,
    )
    expect(at(thresholds.elevated * 0.85, MemoryPressureLevel.Elevated)).toBe(
      MemoryPressureLevel.Elevated,
    )
    expect(at(thresholds.elevated * 0.85 - 1, MemoryPressureLevel.Elevated)).toBe(
      MemoryPressureLevel.Normal,
    )
  })
})

describe('MEMORY_PRESSURE_LEVEL_NAMES', () => {
  it('names every level for log output', () => {
    expect(MEMORY_PRESSURE_LEVEL_NAMES[MemoryPressureLevel.Normal]).toBe('normal')
    expect(MEMORY_PRESSURE_LEVEL_NAMES[MemoryPressureLevel.Elevated]).toBe('elevated')
    expect(MEMORY_PRESSURE_LEVEL_NAMES[MemoryPressureLevel.Critical]).toBe('critical')
  })
})
