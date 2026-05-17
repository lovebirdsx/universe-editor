/**
 * Compute the correct Allotment pane sizes when the secondary sidebar's
 * visibility toggles. With `proportionalLayout={false}`, Allotment tends to
 * give freed space to an adjacent pane (sidebar) instead of the editor area.
 * This function always assigns the freed / needed space to the editor pane.
 *
 * @param snapshot - [sidebar, editor, secondary] sizes captured BEFORE the toggle
 * @param nextVisible - the new visibility state
 * @param secondarySidebarPreferredSize - preferred width when secondary is visible
 * @returns corrected [sidebar, editor, secondary] tuple, or null when the
 *   layout is not yet initialized (total = 0) or the editor would go non-positive.
 */
export function computeResizeAfterSecondaryToggle(
  snapshot: readonly [number, number, number],
  nextVisible: boolean,
  secondarySidebarPreferredSize: number,
): [number, number, number] | null {
  const [sidebar, editor, secondary] = snapshot
  const total = sidebar + editor + secondary
  if (total <= 0) return null

  if (nextVisible) {
    const sec = secondarySidebarPreferredSize
    const newEditor = total - sidebar - sec
    if (newEditor <= 0) return null
    return [sidebar, newEditor, sec]
  } else {
    return [sidebar, editor + secondary, 0]
  }
}
