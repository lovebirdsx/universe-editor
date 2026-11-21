/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  findScrollableElement,
  measureRowHeight,
  scrollViewportByRows,
} from '../list/scrollViewport.js'

function setViewport(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
}

describe('findScrollableElement', () => {
  it('returns the container itself when it scrolls', () => {
    const container = document.createElement('div')
    setViewport(container, 200, 100)
    expect(findScrollableElement(container)).toBe(container)
  })

  it('walks up to the nearest scrollable ancestor', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    outer.appendChild(inner)
    setViewport(outer, 200, 100)
    setViewport(inner, 100, 100)
    expect(findScrollableElement(inner)).toBe(outer)
  })

  it('stops at an explicitly scrollable container even when its content fits', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    inner.style.overflowY = 'auto'
    outer.appendChild(inner)
    setViewport(outer, 200, 100)
    setViewport(inner, 100, 100)
    expect(findScrollableElement(inner)).toBe(inner)
  })

  it('falls back to the container when nothing scrolls', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    outer.appendChild(inner)
    setViewport(outer, 100, 100)
    setViewport(inner, 100, 100)
    expect(findScrollableElement(inner)).toBe(inner)
  })
})

describe('measureRowHeight', () => {
  it('prefers offsetHeight and falls back to the bounding rect', () => {
    const row = document.createElement('div')
    Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 24 })
    expect(measureRowHeight(row)).toBe(24)

    const rectRow = document.createElement('div')
    Object.defineProperty(rectRow, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: 18 }),
    })
    expect(measureRowHeight(rectRow)).toBe(18)
  })

  it('returns undefined for missing or unsized rows', () => {
    expect(measureRowHeight(null)).toBeUndefined()
    expect(measureRowHeight(document.createElement('div'))).toBeUndefined()
  })
})

describe('scrollViewportByRows', () => {
  it('scrolls down and up by count rows', () => {
    const scroller = document.createElement('div')
    scroller.scrollTop = 100
    scrollViewportByRows(scroller, 20, 'down', 2)
    expect(scroller.scrollTop).toBe(140)
    scrollViewportByRows(scroller, 20, 'up', 1)
    expect(scroller.scrollTop).toBe(120)
  })

  it('clamps at the top and uses the default row height', () => {
    const scroller = document.createElement('div')
    scroller.scrollTop = 30
    scrollViewportByRows(scroller, 22, 'up', 5)
    expect(scroller.scrollTop).toBe(0)

    scroller.scrollTop = 0
    scrollViewportByRows(scroller, undefined, 'down', 1)
    expect(scroller.scrollTop).toBe(22)
  })

  it('ignores a missing scroller', () => {
    expect(() => scrollViewportByRows(null, 20, 'down', 1)).not.toThrow()
  })
})
