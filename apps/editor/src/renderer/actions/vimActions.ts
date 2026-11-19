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
  IOutputService,
  KeybindingsRegistry,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IVimModeService } from '../services/vim/vimModeService.js'

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
    const channel = accessor.get(IOutputService).createChannel('Vim Keymap')
    const active = vimModeService.activeSurface
    const kind = active?.kind ?? 'list'
    channel.clear()
    channel.appendLine(
      `Vim keymap — enabled=${vimModeService.getEnabled()} leader=${vimModeService.getLeader()}`,
    )
    channel.appendLine(
      `surface=${kind}${active === undefined ? '' : ` id=${active.id}`} mode=${active === undefined ? '<none>' : vimModeService.getMode(active.surfaceKey, active.defaultMode)}`,
    )
    channel.appendLine('')
    channel.appendLine('Effective keymap:')
    for (const entry of vimModeService.getEffectiveKeymap(kind)) {
      channel.appendLine(
        `  ${entry.keys.join(' ')}  →  ${entry.command}${entry.surfaces === undefined ? '' : `  [${entry.surfaces.join(',')}]`}`,
      )
    }
    channel.appendLine('')
    channel.appendLine(`Reserved keys: ${vimModeService.reservedKeys.join(', ')}`)
    const overrides = vimModeService.getUserKeymap()
    channel.appendLine('')
    channel.appendLine(
      overrides.length === 0
        ? 'User overrides: <none>'
        : `User overrides: ${overrides.map((entry) => `${entry.keys.join(' ')} → ${entry.command}`).join(', ')}`,
    )
    // Keys where a User binding wins before Vim ever sees the stroke. Best
    // effort: token spelling differs from keybindings.json (shift is folded
    // into the character), so compare the first token literally.
    const shadowed: string[] = []
    for (const binding of KeybindingsRegistry.getAllKeybindings()) {
      if ((binding.weight ?? KeybindingWeight.WorkbenchContrib) < KeybindingWeight.User) continue
      if (binding.isNegated === true) continue
      const first = binding.chords?.[0] ?? binding.key
      if (first === undefined) continue
      if (vimModeService.reservedKeys.includes(first)) continue
      shadowed.push(`${first} → ${binding.command}`)
    }
    channel.appendLine('')
    channel.appendLine(
      shadowed.length === 0
        ? 'Shadowed by User bindings: <none>'
        : `Shadowed by User bindings: ${shadowed.join(', ')}`,
    )
  }
}
