/** Shortens UTF-16 text to `max` characters, marking the cut with an ellipsis. */
export function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
