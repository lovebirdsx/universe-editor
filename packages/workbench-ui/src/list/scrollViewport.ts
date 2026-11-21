/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Viewport scrolling shared by every list-like Vim surface. Focus and selection
 *  stay where they are; only the scroller moves.
 *--------------------------------------------------------------------------------------------*/

export const DEFAULT_VIEWPORT_ROW_HEIGHT = 22

/**
 * The DOM scroll container for a list. Hosts often put the focusable container
 * inside a virtualizer's scroller, so walk ancestors until one actually scrolls.
 */
export function findScrollableElement(container: HTMLElement | null): HTMLElement | null {
  for (let element = container; element !== null; element = element.parentElement) {
    if (element.scrollHeight > element.clientHeight) return element
    // An explicitly scrollable box whose content currently fits is still the
    // intended target; walking past it would scroll an unrelated ancestor.
    const inlineOverflow = element.style.overflowY
    if (inlineOverflow === 'auto' || inlineOverflow === 'scroll') return element
    if (typeof getComputedStyle === 'function') {
      const overflowY = getComputedStyle(element).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return element
    }
  }
  return container
}

export function measureRowHeight(row: Element | null | undefined): number | undefined {
  if (row === null || row === undefined) return undefined
  const element = row as HTMLElement
  if (element.offsetHeight > 0) return element.offsetHeight
  const rect = element.getBoundingClientRect()
  if (rect.height > 0) return rect.height
  if (typeof getComputedStyle === 'function') {
    const computed = Number.parseFloat(getComputedStyle(element).height)
    if (Number.isFinite(computed) && computed > 0) return computed
  }
  return undefined
}

export function scrollViewportByRows(
  scroller: HTMLElement | null,
  rowHeight: number | undefined,
  direction: 'up' | 'down',
  count: number,
): void {
  if (scroller === null) return
  const step = Math.max(1, rowHeight ?? DEFAULT_VIEWPORT_ROW_HEIGHT)
  const delta = step * Math.max(1, count)
  // The browser clamps the upper bound; clamping only the lower bound keeps
  // happy-dom (no layout engine, scrollHeight === 0) testable.
  scroller.scrollTop = Math.max(0, scroller.scrollTop + (direction === 'down' ? delta : -delta))
}
