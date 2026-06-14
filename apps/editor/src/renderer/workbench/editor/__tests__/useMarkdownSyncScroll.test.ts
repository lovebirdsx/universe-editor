/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the piecewise-linear interpolation backing markdown scroll sync.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { interpolate } from '../previewScrollMap.js'

describe('interpolate', () => {
  it('returns 0 for no control points', () => {
    expect(interpolate([], 5)).toBe(0)
  })

  it('clamps below the first and above the last key', () => {
    const points = [
      { key: 0, value: 0 },
      { key: 10, value: 100 },
    ]
    expect(interpolate(points, -5)).toBe(0)
    expect(interpolate(points, 50)).toBe(100)
  })

  it('linearly interpolates within a segment', () => {
    const points = [
      { key: 0, value: 0 },
      { key: 10, value: 100 },
    ]
    expect(interpolate(points, 5)).toBe(50)
    expect(interpolate(points, 2)).toBe(20)
  })

  it('picks the correct segment across multiple points', () => {
    const points = [
      { key: 0, value: 0 },
      { key: 10, value: 50 },
      { key: 20, value: 250 },
    ]
    expect(interpolate(points, 15)).toBe(150)
  })

  it('sorts unordered control points by key', () => {
    const points = [
      { key: 20, value: 200 },
      { key: 0, value: 0 },
      { key: 10, value: 100 },
    ]
    expect(interpolate(points, 5)).toBe(50)
  })
})
