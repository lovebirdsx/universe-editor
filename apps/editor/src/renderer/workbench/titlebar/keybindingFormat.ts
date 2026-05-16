/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Render a normalized key string (`ctrl+k`) or chord (`['ctrl+k','ctrl+s']`)
 *  in human-readable form for menus / tooltips / status bar.
 *--------------------------------------------------------------------------------------------*/

export function formatKey(key: string): string {
  return key
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'ctrl') return 'Ctrl'
      if (lower === 'alt') return 'Alt'
      if (lower === 'shift') return 'Shift'
      if (lower === 'meta') return 'Cmd'
      if (lower.length === 1) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('+')
}

export function formatChord(chords: readonly string[]): string {
  return chords.map(formatKey).join(' ')
}
