/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Human-readable spelling of Vim key tokens (`vimKeyToken` output) for the status
 *  bar, which-key and the cheat sheet: `space` → `<Space>`, `ctrl+d` → `<C-d>`,
 *  printable keys unchanged. Pure; the inverse is intentionally not provided.
 *--------------------------------------------------------------------------------------------*/

const NAMED: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'CR',
  tab: 'Tab',
  backspace: 'BS',
  delete: 'Del',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

const MODIFIER_PREFIX: Readonly<Record<string, string>> = {
  ctrl: 'C',
  alt: 'A',
  meta: 'M',
  shift: 'S',
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'meta', 'shift'] as const

/** `<leader>` stays as written: it is a placeholder, not a key. */
export function formatVimToken(token: string): string {
  if (token.length <= 1) return token
  if (token === '<leader>') return '<Leader>'
  let rest = token
  const modifiers: string[] = []
  for (;;) {
    const name = MODIFIER_ORDER.find((candidate) => rest.startsWith(`${candidate}+`))
    if (name === undefined || rest.length === name.length + 1) break
    modifiers.push(MODIFIER_PREFIX[name]!)
    rest = rest.slice(name.length + 1)
  }
  const named = NAMED[rest]
  // Anything that is neither a named key nor a modifier combo (already `<C-x>`,
  // or a multi-character string a caller built) is shown as typed.
  if (named === undefined && modifiers.length === 0) return token
  return `<${[...modifiers, named ?? rest].join('-')}>`
}

/** Compact sequence: `['g', 'g']` → `gg`, `['space', 'w', 'h']` → `<Space>wh`. */
export function formatVimKeys(tokens: readonly string[]): string {
  return tokens.map(formatVimToken).join('')
}

/** Pending display: a typed count followed by the prefix, e.g. `3gg`, `<Space>w`. */
export function formatVimPending(count: number, prefix: readonly string[]): string {
  return `${count > 0 ? String(count) : ''}${formatVimKeys(prefix)}`
}
