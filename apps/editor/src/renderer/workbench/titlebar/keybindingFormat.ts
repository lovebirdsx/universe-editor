/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Render a normalized key string (`ctrl+k`) or chord (`['ctrl+k','ctrl+s']`)
 *  in human-readable form for menus / tooltips / status bar.
 *--------------------------------------------------------------------------------------------*/

import { KeybindingsRegistry } from '@universe-editor/platform'

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

export function resolveShortcut(command: string): string | undefined {
  const all = KeybindingsRegistry.getAllKeybindings()
  for (let i = all.length - 1; i >= 0; i--) {
    const kb = all[i]
    if (!kb || kb.command !== command || kb.isNegated) continue
    if (kb.chords) return formatChord(kb.chords)
    if (kb.key !== undefined) return formatKey(kb.key)
  }
  return undefined
}
