/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared happy-dom harness for the config bar's ResizeObserver-driven
 *  measurement: happy-dom's built-in ResizeObserver never emits, so a test
 *  captures each live observer's callback + observed nodes and fires it on
 *  demand; offsetWidth/clientWidth are stubbed per element, otherwise
 *  everything measures 0 and the bar always "fits" (fake green).
 *--------------------------------------------------------------------------------------------*/

import { act } from '@testing-library/react'

/**
 * Drives a ResizeObserver on demand. The callback is invoked with an empty
 * entries array — the floating-ui autoUpdate observer (created while a surface
 * is open) destructures its entries argument, the config-bar one ignores it.
 */
export class FakeResizeObserver {
  static instances: Array<{ cb: (entries?: unknown) => void; nodes: Element[] }> = []
  private readonly rec: { cb: (entries?: unknown) => void; nodes: Element[] }
  constructor(cb: (entries?: unknown) => void) {
    this.rec = { cb, nodes: [] }
    FakeResizeObserver.instances.push(this.rec)
  }
  observe(node: Element): void {
    this.rec.nodes.push(node)
  }
  unobserve(): void {}
  disconnect(): void {
    const i = FakeResizeObserver.instances.indexOf(this.rec)
    if (i !== -1) FakeResizeObserver.instances.splice(i, 1)
  }
}

export function stubWidth(el: Element, width: number): void {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
}

export function stubClientWidth(el: Element, width: number): void {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
}

/** Fire the captured RO callbacks and flush the rAF the measurement is batched through. */
export async function fireResize() {
  await act(async () => {
    for (const o of FakeResizeObserver.instances) o.cb([])
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
