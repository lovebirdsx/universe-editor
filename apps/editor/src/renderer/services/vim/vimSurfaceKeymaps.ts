/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Keys that only one view understands, declared next to the view through
 *  `useVimSurfaceKeymap(vimSurfaceKeyFor('list', '<id>'), …)` instead of a
 *  `when: "vimSurfaceId == …"` string in the global table. Kept in one module
 *  so the service can list their ids as known built-ins when it validates
 *  `vim.keymap` (an override of `list.focusSettingsSearch` is legitimate).
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'

/** Settings rows and TOC: `/` hands focus to the settings search box. */
export const SETTINGS_SURFACE_KEYMAP: readonly IVimKeymapEntry[] = [
  {
    id: 'list.focusSettingsSearch',
    keys: ['/'],
    command: 'workbench.action.focusSettingsSearch',
  },
]

export const KEYBINDINGS_SURFACE_KEYMAP: readonly IVimKeymapEntry[] = [
  {
    id: 'list.focusKeybindingsSearch',
    keys: ['/'],
    command: 'keybindings.editor.searchKeybindings',
  },
]

export const PERFORCE_GRAPH_SURFACE_KEYMAP: readonly IVimKeymapEntry[] = [
  {
    id: 'list.focusPerforceGraphSearch',
    keys: ['/'],
    command: 'perforce-graph.focusSearch',
  },
]

export const GIT_GRAPH_SURFACE_KEYMAP: readonly IVimKeymapEntry[] = [
  {
    id: 'list.focusGitGraphSearch',
    keys: ['/'],
    command: 'git-graph.focusSearch',
  },
]

export const VIM_SURFACE_KEYMAPS: readonly IVimKeymapEntry[] = [
  ...SETTINGS_SURFACE_KEYMAP,
  ...KEYBINDINGS_SURFACE_KEYMAP,
  ...PERFORCE_GRAPH_SURFACE_KEYMAP,
  ...GIT_GRAPH_SURFACE_KEYMAP,
]
