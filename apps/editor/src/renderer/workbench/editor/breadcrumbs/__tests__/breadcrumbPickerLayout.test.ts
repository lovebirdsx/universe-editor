/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/breadcrumbPickerLayout.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeBreadcrumbPickerLayout } from '../breadcrumbPickerLayout.js'

const anchor = { left: 40, top: 30, width: 100, height: 22 }

describe('computeBreadcrumbPickerLayout', () => {
  it('caps the width to a quarter of a wide viewport', () => {
    const layout = computeBreadcrumbPickerLayout(anchor, { width: 1920, height: 1080 })
    expect(layout.width).toBeCloseTo((1920 - 8) / 4.17, 5)
    expect(layout.x).toBe(40)
    expect(layout.y).toBe(52)
    expect(layout.maxHeight).toBe(300)
  })

  it('keeps a minimum width on narrow viewports', () => {
    const layout = computeBreadcrumbPickerLayout(anchor, { width: 800, height: 600 })
    expect(layout.width).toBeGreaterThanOrEqual(240)
    expect(layout.width).toBeLessThanOrEqual(800 - 8)
  })

  it('never exceeds the viewport width', () => {
    const layout = computeBreadcrumbPickerLayout(anchor, { width: 200, height: 600 })
    expect(layout.width).toBeLessThanOrEqual(192)
  })

  it('shrinks the height when the anchor is near the bottom', () => {
    const layout = computeBreadcrumbPickerLayout(
      { left: 0, top: 700, width: 80, height: 22 },
      { width: 1024, height: 768 },
    )
    expect(layout.maxHeight).toBe(16)
  })

  it('never returns a negative height', () => {
    const layout = computeBreadcrumbPickerLayout(
      { left: 0, top: 800, width: 80, height: 22 },
      { width: 1024, height: 768 },
    )
    expect(layout.maxHeight).toBe(0)
  })
})
