/*---------------------------------------------------------------------------------------------
 *  Resize-edge guard for draggable resource rows.
 *
 *  A sidebar row is `draggable` and fills the pane's full width, so its left /
 *  right edge coincides with the resize sash between the pane and its neighbour
 *  (primary sidebar → right, secondary sidebar → left). A pointer press that
 *  lands a couple of pixels off the thin sash strip hits the row underneath and
 *  the browser starts a *content* drag instead of a resize. Cancelling the drag
 *  when it starts within `edge` px of a horizontal row edge keeps that gesture a
 *  resize (or a harmless no-op where there is no sash).
 *--------------------------------------------------------------------------------------------*/

/** px band on each side treated as "resize intent, not content drag". */
export const RESIZE_EDGE_PX = 6

/**
 * Whether a drag starting at `clientX` should be suppressed because the press
 * landed on a row's left / right edge — the seam a resize sash lives on.
 * `target` may be null/undefined when no element is available to measure (e.g.
 * unit-test mock events); in that case the drag is never suppressed.
 */
export function isResizeEdgeDrag(
  target: { getBoundingClientRect(): { left: number; right: number } } | null | undefined,
  clientX: number,
  edge: number = RESIZE_EDGE_PX,
): boolean {
  if (!target || typeof target.getBoundingClientRect !== 'function') return false
  if (!Number.isFinite(clientX)) return false
  const rect = target.getBoundingClientRect()
  if (rect.right <= rect.left) return false
  // Only a press *inside* the row that lands within `edge` px of a boundary is a
  // resize gesture. A coordinate outside the row entirely (e.g. a synthetic 0,0
  // dragstart) is a normal drag, not an edge press.
  if (clientX < rect.left || clientX > rect.right) return false
  return clientX <= rect.left + edge || clientX >= rect.right - edge
}
