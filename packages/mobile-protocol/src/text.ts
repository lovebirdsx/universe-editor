/** Shortens UTF-16 text to `max` characters, marking the cut with an ellipsis. */
export function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** WS frame limits are bytes, not UTF-16 units; budgets must use this. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}
