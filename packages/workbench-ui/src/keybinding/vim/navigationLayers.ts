/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Shared arbitration for "which mounted navigation surface owns this stroke".
 *  Both the Ctrl-alias registry and the global Vim surface registry need the
 *  same three rules — active check, nested/innermost preference, newest wins —
 *  so they live here instead of drifting in two copies.
 *--------------------------------------------------------------------------------------------*/

import { isEditableElement } from '../../dom/domRealm.js'

export interface INavigationLayerView {
  readonly kind: string
  readonly sequence: number
  readonly enabled?: boolean | undefined
  readonly getElement?: (() => HTMLElement | null) | undefined
  readonly focus?: 'self' | 'within' | undefined
  readonly allowEditableFocus?: boolean | undefined
}

function elementDepth(element: Element): number {
  let depth = 0
  for (let node = element.parentElement; node !== null; node = node.parentElement) depth++
  return depth
}

/**
 * A surface is active when enabled and either always-on for its kind or holding
 * the focus as required. Editable targets are rejected unless the surface opts
 * in: a search box inside a list keeps typing, while an xterm textarea (also a
 * TEXTAREA) is claimed by a terminal surface that does.
 */
export function isNavigationLayerActive(
  layer: INavigationLayerView,
  doc: Document,
  isAlwaysActive: (kind: string) => boolean,
): boolean {
  if (layer.enabled === false) return false
  if (isAlwaysActive(layer.kind)) return true
  const element = layer.getElement?.() ?? null
  if (element === null) return false
  const active = doc.activeElement
  if (active === null) return false
  if (layer.allowEditableFocus !== true && isEditableElement(active)) return false
  const focus = layer.focus ?? 'self'
  return focus === 'within' ? element.contains(active) : active === element
}

/**
 * Whether `a` beats `b` for the same stroke: kind priority first, then the
 * innermost surface, then the most recently mounted one.
 */
export function navigationLayerOutranks(
  a: INavigationLayerView,
  b: INavigationLayerView,
  priority: (kind: string) => number,
): boolean {
  const priorityDelta = priority(a.kind) - priority(b.kind)
  if (priorityDelta !== 0) return priorityDelta > 0
  const aElement = a.getElement?.() ?? null
  const bElement = b.getElement?.() ?? null
  if (aElement !== null && bElement !== null && aElement !== bElement) {
    if (aElement.contains(bElement)) return false
    if (bElement.contains(aElement)) return true
    const depthDelta = elementDepth(aElement) - elementDepth(bElement)
    if (depthDelta !== 0) return depthDelta > 0
  }
  return a.sequence > b.sequence
}

export function pickNavigationLayer<T extends INavigationLayerView>(
  layers: Iterable<T>,
  doc: Document,
  isAlwaysActive: (kind: string) => boolean,
  priority: (kind: string) => number,
): T | undefined {
  let best: T | undefined
  for (const layer of layers) {
    if (!isNavigationLayerActive(layer, doc, isAlwaysActive)) continue
    if (best === undefined || navigationLayerOutranks(layer, best, priority)) best = layer
  }
  return best
}
