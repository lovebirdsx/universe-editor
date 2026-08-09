/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Render a normalized key string (`ctrl+k`) or chord (`['ctrl+k','ctrl+s']`)
 *  in human-readable form for menus / tooltips / status bar.
 *--------------------------------------------------------------------------------------------*/

import { KeybindingsRegistry } from '@universe-editor/platform'
import { getMonacoDefaultKeybinding } from '../editor/monaco/monacoActionsBridge.js'

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
  // A positive binding is suppressed when a `-command` (negated) entry targets
  // the same (command, chords) — mirrors the registry's removal semantics so a
  // user-disabled default key stops showing up in menus/tooltips.
  const negations = new Set<string>()
  for (const kb of all) {
    if (!kb?.isNegated) continue
    negations.add(`${kb.command}|${kb.chords ? kb.chords.join(' ') : (kb.key ?? '')}`)
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const kb = all[i]
    if (!kb || kb.command !== command || kb.isNegated) continue
    const key = kb.chords ? kb.chords.join(' ') : kb.key
    if (key === undefined || negations.has(`${command}|${key}`)) continue
    return kb.chords ? formatChord(kb.chords) : formatKey(key)
  }
  // Monaco-owned commands (undo/redo/clipboard/selectAll) don't register their
  // defaults with KeybindingsRegistry; fall back to the bridge's side-table.
  const monacoDefault = getMonacoDefaultKeybinding(command)
  if (monacoDefault?.chords) return formatChord(monacoDefault.chords)
  if (monacoDefault?.key !== undefined) return formatKey(monacoDefault.key)
  return undefined
}
