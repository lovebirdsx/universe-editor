// Map browser KeyboardEvent.key values to our canonical key names where they differ.
export const DOM_KEY_MAP: Record<string, string> = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
}

// Shift mutates `e.key` for the number row (e.g. 5 → %, ` → ~), so those keys
// would build as `ctrl+shift+%` and never match a `ctrl+shift+5` binding.
// Resolve them from the layout-independent `e.code` instead.
export const CODE_KEY_MAP: Record<string, string> = {
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Backquote: '`',
}

export function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  const raw = e.key.toLowerCase()
  parts.push(CODE_KEY_MAP[e.code] ?? DOM_KEY_MAP[raw] ?? raw)
  return parts.join('+')
}

export function isModifierOnly(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'control' || k === 'shift' || k === 'alt' || k === 'meta'
}

// Treat ctrl / alt / meta as "functional" modifiers. Shift alone is part of
// normal text input (e.g. typing capital letters) and must not bypass the
// editable-target guard.
export function hasFunctionalModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.altKey || e.metaKey
}
