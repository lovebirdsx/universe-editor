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
  IQuickInputService,
  KeybindingsRegistry,
  KeybindingWeight,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  getActiveVimSurface,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'
import { IVimModeService } from '../services/vim/vimModeService.js'
import { resolveVimCommandTitle } from '../services/vim/vimCommandTitle.js'
import { buildVimCheatSheetItems, type IVimKeyHelpRow } from '../services/vim/vimCheatSheet.js'
import {
  currentWorkbenchDocumentOrUndefined,
  getActiveWorkbenchDocument,
} from '../services/windows/workbenchDocuments.js'

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
      category: localize2('command.category.vim', 'Vim'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const enabled = config.get<boolean>('vim.enabled') === true
    config.update('vim.enabled', !enabled, ConfigurationTarget.User)
  }
}

const CHEAT_SHEET_KINDS: readonly VimSurfaceKind[] = [
  'editor',
  'list',
  'menu',
  'overlay',
  'tabs',
  'activityBar',
  'viewContainerTabs',
  'terminal',
  'reader',
]

/**
 * Searchable key reference grouped by surface. Complements `showActiveKeymap`, which stays the
 * raw diagnostic dump (shadowing, reserved keys, parse problems) in the Output panel.
 */
export class ShowVimCheatSheetAction extends Action2 {
  static readonly ID = 'workbench.action.vim.showKeymapCheatSheet'
  constructor() {
    super({
      id: ShowVimCheatSheetAction.ID,
      title: localize2('action.vim.showKeymapCheatSheet.title', 'Vim: Show Keymap Cheat Sheet'),
      category: localize2('command.category.vim', 'Vim'),
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Services are fetched before the first await: the accessor dies there.
    const vim = accessor.get(IVimModeService)
    const quickInput = accessor.get(IQuickInputService)
    const activeSurface = getActiveVimSurface(getActiveWorkbenchDocument())
    const activeKind = vim.activeSurface?.kind
    const keymaps = new Map<VimSurfaceKind, readonly IVimKeymapEntry[]>()
    for (const kind of CHEAT_SHEET_KINDS) {
      const own = activeSurface?.surface.kind === kind ? activeSurface.keymap : undefined
      keymaps.set(kind, vim.getEffectiveKeymap(kind, own))
    }
    let editorHelp: readonly IVimKeyHelpRow[] = []
    try {
      const help = await import('../workbench/editor/vim/vimKeyHelp.js')
      editorHelp = help.getVimEditorKeyHelp()
    } catch (error) {
      console.warn('[vim] editor key help unavailable', error)
    }
    const items = buildVimCheatSheetItems({
      activeKind,
      keymaps,
      editorHelp,
      resolveTitle: resolveVimCommandTitle,
    })
    console.debug(`[vim] cheat sheet rows=${items.length} active=${activeKind ?? '<none>'}`)
    await quickInput.pick(items, {
      id: 'vim.cheatSheet',
      placeholder: localize('vim.cheatSheet.placeholder', 'Filter Vim keys or commands'),
      matchOnDescription: true,
    })
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
    const userOverrideIds = new Set(
      userKeymap.filter((item) => !item.unbind && item.id !== undefined).map((item) => item.id),
    )
    const issues = vimModeService.getUserKeymapIssues()
    const doc = currentWorkbenchDocumentOrUndefined()
    const entries =
      active === undefined
        ? []
        : vimModeService.getEffectiveKeymap(
            active.kind,
            (doc === undefined ? undefined : getActiveVimSurface(doc))?.keymap,
          )

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
        const surfaceMark =
          entry.scope === 'surface'
            ? '  [this surface]'
            : entry.surfaces === undefined
              ? ''
              : `  [${entry.surfaces.join(',')}]`
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
    for (const item of userKeymap) {
      const surfaceMark = item.surfaces === undefined ? '' : `  [${item.surfaces.join(',')}]`
      const keys = item.keys === undefined ? '<inherited>' : item.keys.join(' ')
      if (item.unbind) {
        const target = item.id ?? `${keys}${item.command ? ` (${item.command})` : ''}`
        channel.appendLine(`  unbind ${target}${surfaceMark}`)
      } else {
        channel.appendLine(
          `  ${item.id ?? '?'}: ${keys}  →  ${item.command ?? '<inherited>'}${surfaceMark}`,
        )
      }
    }
    if (issues.length > 0) {
      channel.appendLine('')
      channel.appendLine('Problems in vim.keymap (these entries were ignored or trimmed):')
      for (const issue of issues) channel.appendLine(`  ${issue}`)
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
