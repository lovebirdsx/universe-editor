/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the source-line ↔ preview-pixel helpers shared by scroll sync and
 *  the Outline view's reveal / active-symbol tracking.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  clampRevealScrollTop,
  lineForPreviewTop,
  previewTopForLine,
  type LineEntry,
} from '../previewScrollMap.js'

const entries: LineEntry[] = [
  { line: 1, top: 0 },
  { line: 5, top: 100 },
  { line: 11, top: 300 },
]

describe('previewTopForLine', () => {
  it('maps a mapped line to its pixel top', () => {
    expect(previewTopForLine(entries, 5)).toBe(100)
  })

  it('interpolates between mapped lines', () => {
    expect(previewTopForLine(entries, 3)).toBe(50)
  })

  it('clamps before the first and after the last entry', () => {
    expect(previewTopForLine(entries, -2)).toBe(0)
    expect(previewTopForLine(entries, 99)).toBe(300)
  })
})

describe('lineForPreviewTop', () => {
  it('maps a pixel top back to a rounded source line', () => {
    expect(lineForPreviewTop(entries, 100)).toBe(5)
    expect(lineForPreviewTop(entries, 50)).toBe(3)
  })

  it('clamps outside the mapped pixel range', () => {
    expect(lineForPreviewTop(entries, -10)).toBe(1)
    expect(lineForPreviewTop(entries, 9999)).toBe(11)
  })
})

describe('clampRevealScrollTop', () => {
  it('returns the line top when it fits above the last useful scroll', () => {
    expect(clampRevealScrollTop({ lineTop: 200, contentBottom: 1000, viewportHeight: 400 })).toBe(
      200,
    )
  })

  it('clamps a near-the-end line so the last line sits flush at the bottom', () => {
    // maxUseful = 1000 - 400 = 600; a lineTop past that would leave blank padding
    // (scroll-beyond-last-line) below the last line.
    expect(clampRevealScrollTop({ lineTop: 950, contentBottom: 1000, viewportHeight: 400 })).toBe(
      600,
    )
  })

  it('never returns a negative scrollTop (content shorter than the viewport)', () => {
    expect(clampRevealScrollTop({ lineTop: 0, contentBottom: 200, viewportHeight: 400 })).toBe(0)
  })
})
