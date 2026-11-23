/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Quick pick rows for "Vim: Show Keymap Cheat Sheet". Pure: the action supplies
 *  every surface's effective keymap (user overrides and unbinds already merged) and
 *  the editor core's key help; this only groups, orders and formats them.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IQuickPickItem, type QuickPickInput } from '@universe-editor/platform'
import type { IVimKeymapEntry, VimSurfaceKind } from '@universe-editor/workbench-ui'
import { formatVimKeys } from './vimKeyFormat.js'

export interface IVimKeyHelpRow {
  readonly group: string
  readonly keys: string
  readonly description: string
}

export interface IVimCheatSheetInput {
  /** Surface that had the keyboard when the command ran; its section comes first. */
  readonly activeKind: VimSurfaceKind | undefined
  readonly keymaps: ReadonlyMap<VimSurfaceKind, readonly IVimKeymapEntry[]>
  readonly editorHelp: readonly IVimKeyHelpRow[]
  readonly resolveTitle: (command: string) => string
}

const SURFACE_ORDER: readonly VimSurfaceKind[] = [
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

export function vimSurfaceLabel(kind: VimSurfaceKind): string {
  switch (kind) {
    case 'editor':
      return localize('vim.cheatSheet.surface.editor', 'Editor')
    case 'list':
      return localize('vim.cheatSheet.surface.list', 'Lists and Trees')
    case 'menu':
      return localize('vim.cheatSheet.surface.menu', 'Menus')
    case 'overlay':
      return localize('vim.cheatSheet.surface.overlay', 'Popups and Pickers')
    case 'tabs':
      return localize('vim.cheatSheet.surface.tabs', 'Editor Tabs')
    case 'activityBar':
      return localize('vim.cheatSheet.surface.activityBar', 'Activity Bar')
    case 'viewContainerTabs':
      return localize('vim.cheatSheet.surface.viewContainerTabs', 'View Tabs')
    case 'terminal':
      return localize('vim.cheatSheet.surface.terminal', 'Terminal (Normal Mode)')
    case 'reader':
      return localize('vim.cheatSheet.surface.reader', 'Reading Views')
    case 'webview':
      return localize('vim.cheatSheet.surface.webview', 'Webviews')
  }
}

function orderedKinds(active: VimSurfaceKind | undefined): readonly VimSurfaceKind[] {
  if (active === undefined || !SURFACE_ORDER.includes(active)) return SURFACE_ORDER
  return [active, ...SURFACE_ORDER.filter((kind) => kind !== active)]
}

export function buildVimCheatSheetItems(input: IVimCheatSheetInput): QuickPickInput[] {
  const items: QuickPickInput[] = []
  const activeMark = localize('vim.cheatSheet.current', '(current)')

  for (const kind of orderedKinds(input.activeKind)) {
    const entries = input.keymaps.get(kind) ?? []
    const core = kind === 'editor' ? input.editorHelp : []
    if (entries.length === 0 && core.length === 0) continue

    // Consecutive separators collapse in the quick pick, so sub-groups carry the surface name.
    const surface = vimSurfaceLabel(kind)
    const heading = kind === input.activeKind ? `${surface} ${activeMark}` : surface
    if (core.length === 0) items.push({ type: 'separator', id: `sep:${kind}`, label: heading })

    let lastGroup: string | undefined
    for (const [index, row] of core.entries()) {
      if (row.group !== lastGroup) {
        lastGroup = row.group
        items.push({
          type: 'separator',
          // The first divider also anchors the surface section.
          id: index === 0 ? `sep:${kind}` : `sep:${kind}:core:${row.group}`,
          label: `${heading} · ${row.group}`,
        })
      }
      items.push({
        id: `${kind}:core:${index}`,
        label: row.keys,
        description: row.description,
        keywords: [row.group],
      })
    }

    if (core.length > 0 && entries.length > 0) {
      items.push({
        type: 'separator',
        id: `sep:${kind}:workbench`,
        label: `${heading} · ${localize('vim.cheatSheet.workbenchKeys', 'Workbench Commands')}`,
      })
    }
    for (const entry of entries) {
      const keywords = [entry.command]
      if (entry.when !== undefined) keywords.push(entry.when)
      const item: IQuickPickItem = {
        id: `${kind}:${entry.id}`,
        label: formatVimKeys(entry.keys),
        description: input.resolveTitle(entry.command),
        keywords,
      }
      items.push(item)
    }
  }
  return items
}
