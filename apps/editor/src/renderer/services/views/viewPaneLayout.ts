/*---------------------------------------------------------------------------------------------
 *  View pane layout math for the stacked (Allotment) view container.
 *
 *  Mirrors VSCode's SplitView semantics (splitview.ts resize/relayout):
 *   - a collapsed pane is modelled as a fixed-size view (min = max = header);
 *   - collapsing hands the freed space to the bottom-most expanded pane
 *     (SplitView's greedy resize, where maxSize = Infinity absorbs it all);
 *   - expanding restores the pane's remembered size, taking the space back
 *     from the other expanded panes bottom-up, each shrinkable to OPEN_MIN.
 *  Kept pure so the renderer-node test project can cover it without DOM.
 *--------------------------------------------------------------------------------------------*/

export const VIEW_HEADER_SIZE = 28
export const VIEW_MIN_BODY = 60
export const VIEW_OPEN_MIN = VIEW_HEADER_SIZE + VIEW_MIN_BODY

export interface ComputeToggleSizesArgs {
  /** Current pane sizes, aligned with `collapsed`. */
  readonly sizes: readonly number[]
  /** Collapsed flags AFTER the toggle. */
  readonly collapsed: readonly boolean[]
  /** Index of the pane being toggled. */
  readonly toggledIndex: number
  /** Persisted expanded size to restore when expanding; falls back to an even share. */
  readonly restoreSize?: number
}

/**
 * Sizes to apply after a collapse/expand toggle, or undefined when no sane
 * layout can be computed (bad input, empty total, or every pane collapsed).
 */
export function computeToggleSizes(args: ComputeToggleSizesArgs): number[] | undefined {
  const { sizes, collapsed, toggledIndex } = args
  if (sizes.length === 0 || sizes.length !== collapsed.length) return undefined
  if (toggledIndex < 0 || toggledIndex >= sizes.length) return undefined
  const total = sizes.reduce((sum, n) => sum + n, 0)
  if (total <= 0) return undefined

  const openIndexes: number[] = []
  for (let i = 0; i < collapsed.length; i++) {
    if (!collapsed[i]) openIndexes.push(i)
  }
  if (openIndexes.length === 0) return undefined

  const desired = sizes.map((size, i) => (collapsed[i] ? VIEW_HEADER_SIZE : size))
  const expanding = !collapsed[toggledIndex]
  if (expanding) {
    const headers = collapsed.reduce((n, c) => n + (c ? VIEW_HEADER_SIZE : 0), 0)
    const share = Math.max(VIEW_OPEN_MIN, (total - headers) / openIndexes.length)
    desired[toggledIndex] = Math.max(VIEW_OPEN_MIN, args.restoreSize ?? share)
  }

  // delta > 0: freed space to hand out; delta < 0: space to take back.
  const delta = total - desired.reduce((sum, n) => sum + n, 0)
  // Bottom-up over the OTHER open panes; the toggled pane never donates.
  const donors = openIndexes.filter((i) => i !== toggledIndex).reverse()
  if (delta > 0) {
    // Collapse: SplitView's greedy resize lets the bottom-most open pane (whose
    // maxSize is Infinity) absorb everything.
    const receiver = donors.length > 0 ? donors[0]! : toggledIndex
    desired[receiver] = (desired[receiver] ?? 0) + delta
  } else if (delta < 0) {
    let need = -delta
    for (const i of donors) {
      if (need <= 0) break
      const give = Math.min((desired[i] ?? 0) - VIEW_OPEN_MIN, need)
      if (give > 0) {
        desired[i] = (desired[i] ?? 0) - give
        need -= give
      }
    }
    // Donors bottomed out: the expanding pane settles for what's left.
    if (need > 0 && expanding) {
      const current = desired[toggledIndex] ?? 0
      desired[toggledIndex] = Math.max(VIEW_OPEN_MIN, current - need)
    }
  }
  return desired
}

/** Initial size for an Allotment pane (preferredSize): stored expanded size, clamped. */
export function initialPaneSize(
  collapsed: boolean,
  storedSize: number | undefined,
): number | undefined {
  if (collapsed) return VIEW_HEADER_SIZE
  return storedSize !== undefined ? Math.max(VIEW_OPEN_MIN, storedSize) : undefined
}
