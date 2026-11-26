/*---------------------------------------------------------------------------------------------
 *  Keyboard-triggered tooltips. The global `TooltipProvider` owns the rendering;
 *  this module is the React-free bridge Vim list surfaces use to ask it to show
 *  the focused row's tooltip on `K`, and that the navigation dispatcher uses to
 *  dismiss it on the next stroke. Each workbench document (main / auxiliary
 *  windows) has its own provider, so controllers are registered per document.
 *--------------------------------------------------------------------------------------------*/

import { isElementLike } from '../dom/domRealm.js'
import { rowTooltipTarget } from './tooltipAttributes.js'

export interface KeyboardTooltipRequest {
  readonly target: Element
  /** Row root anchoring the target; polled for selection loss. */
  readonly row?: Element | undefined
}

export interface KeyboardTooltipController {
  show(request: KeyboardTooltipRequest): void
  hide(): void
  /** Re-read the target's attributes (lazy-filled text). */
  refresh(): void
}

const controllers = new WeakMap<Document, KeyboardTooltipController[]>()

/**
 * The most recently registered provider wins. StrictMode's mount/unmount drill
 * and a document briefly hosting two providers both end with one live entry.
 */
function activeController(doc: Document): KeyboardTooltipController | undefined {
  const list = controllers.get(doc)
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1]
}

export function registerKeyboardTooltipController(
  doc: Document,
  controller: KeyboardTooltipController,
): { dispose(): void } {
  const list = controllers.get(doc) ?? []
  list.push(controller)
  controllers.set(doc, list)
  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      const current = controllers.get(doc)
      if (current === undefined) return
      const index = current.lastIndexOf(controller)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) controllers.delete(doc)
    },
  }
}

/**
 * Show the tooltip a pointer hovering `row` would show. Resolves the owning
 * document from the row, so auxiliary windows need no special handling. Returns
 * false when the row is gone, has no tooltip, or no provider is mounted.
 */
export function showKeyboardTooltipForRow(row: Element | null | undefined): boolean {
  if (!isElementLike(row) || row.isConnected !== true) return false
  const target = rowTooltipTarget(row)
  if (target === null) return false
  const controller = activeController(row.ownerDocument)
  if (controller === undefined) return false
  controller.show({ target, row })
  return true
}

/** Dismiss a keyboard-triggered tooltip; pointer/focus tooltips are untouched. */
export function hideKeyboardTooltip(doc: Document): void {
  activeController(doc)?.hide()
}

/** Re-read the current keyboard tooltip's text after a host fills it lazily. */
export function refreshKeyboardTooltip(doc: Document): void {
  activeController(doc)?.refresh()
}
