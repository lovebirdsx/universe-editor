/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim workbench commands: the global on/off switch and a diagnostic dump of
 *  the effective keymap (default table, user overrides, reserved set and keys a
 *  User binding shadows).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  IContextKeyService,
  IOutputService,
  KeybindingsRegistry,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IVimModeService } from '../services/vim/vimModeService.js'

/**
 * Vim tokens use their own spelling (`G`, `?`), while the keybinding registry
 * compares normalized keystrokes (`shift+g`, `shift+/`). Map the first token of
 * an entry so the shadow probe asks about the same stroke a user would bind.
 */
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
}

function keybindingStringForToken(token: string): string {
  if (token.length > 1) return token
  if (token >= 'A' && token <= 'Z') return `shift+${token.toLowerCase()}`
  const shiftedBase = SHIFTED_SYMBOLS[token]
  return shiftedBase === undefined ? token : `shift+${shiftedBase}`
}

function sameReservedToken(token: string, reserved: readonly string[]): boolean {
  return reserved.includes(token.length > 1 ? token.toLowerCase() : token)
}

export class ToggleVimModeAction extends Action2 {
  static readonly ID = 'workbench.action.toggleVimMode'
  constructor() {
    super({
      id: ToggleVimModeAction.ID,
      title: localize2('action.toggleVimMode.title', 'Toggle Vim Mode'),
      category: localize2('command.category.editor', 'Editor'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const enabled = config.get<boolean>('vim.enabled') === true
    config.update('vim.enabled', !enabled, ConfigurationTarget.User)
  }
}

export class ShowActiveVimKeymapAction extends Action2 {
  static readonly ID = 'workbench.action.vim.showActiveKeymap'
  constructor() {
    super({
      id: ShowActiveVimKeymapAction.ID,
      title: localize2('action.vim.showActiveKeymap.title', 'Vim: Show Active Keymap'),
      category: localize2('command.category.vim', 'Vim'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    // All services are fetched synchronously — the accessor dies at the first await.
    const vimModeService = accessor.get(IVimModeService)
    const contextKeyService = accessor.get(IContextKeyService)
    const channel = accessor.get(IOutputService).createChannel('Vim Keymap')
    const active = vimModeService.activeSurface
    const reserved = vimModeService.reservedKeys
    const userKeymap = vimModeService.getUserKeymap()
    const userOverrideIds = new Set(userKeymap.map((entry) => entry.id))
    const entries = active === undefined ? [] : vimModeService.getEffectiveKeymap(active.kind)

    channel.clear()
    channel.appendLine(
      `Vim keymap — enabled=${vimModeService.getEnabled()} leader=${vimModeService.getLeader()}`,
    )
    channel.appendLine(
      active === undefined
        ? 'Active surface: <none> (focus a Vim surface and run this command again)'
        : `Active surface: ${active.kind} id=${active.id} key=${active.surfaceKey} mode=${vimModeService.getMode(active.surfaceKey, active.defaultMode)}`,
    )

    channel.appendLine('')
    channel.appendLine('Effective keymap:')
    if (entries.length === 0) {
      channel.appendLine('  <none — no active surface>')
    } else {
      for (const entry of entries) {
        const userMark = userOverrideIds.has(entry.id) ? '  (user override)' : ''
        const surfaceMark = entry.surfaces === undefined ? '' : `  [${entry.surfaces.join(',')}]`
        channel.appendLine(
          `  ${entry.keys.join(' ')}  →  ${entry.command}${userMark}${surfaceMark}`,
        )
      }
    }

    channel.appendLine('')
    channel.appendLine(
      userKeymap.length === 0
        ? 'User overrides (vim.keymap): <none>'
        : 'User overrides (vim.keymap):',
    )
    for (const entry of userKeymap) {
      const surfaceMark = entry.surfaces === undefined ? '' : `  [${entry.surfaces.join(',')}]`
      channel.appendLine(
        `  ${entry.id}: ${entry.keys.join(' ')}  →  ${entry.command}${surfaceMark}`,
      )
    }

    channel.appendLine('')
    channel.appendLine('Reserved keys (User bindings never shadow these):')
    channel.appendLine(`  ${reserved.join(', ')}`)

    channel.appendLine('')
    const shadowed = new Map<string, string[]>()
    for (const entry of entries) {
      const first = entry.keys[0]
      if (first === undefined) continue
      if (sameReservedToken(first, reserved)) continue
      const key = keybindingStringForToken(first)
      if (!KeybindingsRegistry.hasBindingAtOrAbove(key, KeybindingWeight.User, contextKeyService)) {
        continue
      }
      const resolved = KeybindingsRegistry.resolveKeystroke(key, contextKeyService)
      const command = resolved.kind === 'execute' ? resolved.command : '<unknown>'
      const commands = shadowed.get(first) ?? []
      if (!commands.includes(command)) commands.push(command)
      shadowed.set(first, commands)
    }
    channel.appendLine('Shadowed by User bindings:')
    if (shadowed.size === 0) {
      channel.appendLine('  <none>')
    } else {
      for (const [token, commands] of shadowed) {
        channel.appendLine(`  ${token} → ${commands.join(', ')}`)
      }
    }
  }
}
