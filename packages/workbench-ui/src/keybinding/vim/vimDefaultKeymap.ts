/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in Vim keymap. Keys are Vim tokens (see `vimKeyToken`): printable keys
 *  keep their case, so `g` is a prefix and `G` a command. `<leader>` is a
 *  placeholder replaced by `IVimModeService` with the configured leader key.
 *
 *  Entries name command ids, never implementations — the dispatcher executes
 *  them through ICommandService so extensions and user keybindings see the same
 *  surface.
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry, VimSurfaceKind } from './vimTypes.js'

const LIST_LIKE: readonly VimSurfaceKind[] = ['list', 'menu', 'overlay']
const CHROME_LIKE: readonly VimSurfaceKind[] = ['tabs', 'activityBar', 'viewContainerTabs']

export const VIM_DEFAULT_KEYMAP: readonly IVimKeymapEntry[] = [
  // -- lists, menus, overlays -------------------------------------------------
  { id: 'list.focusDown', keys: ['j'], command: 'list.focusDown', surfaces: LIST_LIKE },
  { id: 'list.focusUp', keys: ['k'], command: 'list.focusUp', surfaces: LIST_LIKE },
  { id: 'list.focusLeft', keys: ['h'], command: 'list.focusLeft', surfaces: LIST_LIKE },
  { id: 'list.focusRight', keys: ['l'], command: 'list.focusRight', surfaces: LIST_LIKE },
  { id: 'list.focusFirst', keys: ['g', 'g'], command: 'list.focusFirst', surfaces: LIST_LIKE },
  { id: 'list.focusLast', keys: ['G'], command: 'list.focusLast', surfaces: LIST_LIKE },
  {
    id: 'list.pageDown',
    keys: ['ctrl+d'],
    command: 'list.pageDown',
    surfaces: LIST_LIKE,
  },
  { id: 'list.pageUp', keys: ['ctrl+u'], command: 'list.pageUp', surfaces: LIST_LIKE },
  {
    id: 'list.activate.enter',
    keys: ['enter'],
    command: 'list.activate',
    surfaces: LIST_LIKE,
  },
  { id: 'list.activate.o', keys: ['o'], command: 'list.activate', surfaces: LIST_LIKE },
  {
    id: 'list.activatePreview',
    keys: ['p'],
    command: 'list.activatePreview',
    surfaces: LIST_LIKE,
  },
  { id: 'list.toggle', keys: ['z', 'a'], command: 'list.toggle', surfaces: LIST_LIKE },
  { id: 'list.expand', keys: ['z', 'o'], command: 'list.expand', surfaces: LIST_LIKE },
  { id: 'list.collapse', keys: ['z', 'c'], command: 'list.collapse', surfaces: LIST_LIKE },
  { id: 'list.contextMenu', keys: ['m'], command: 'list.contextMenu', surfaces: LIST_LIKE },
  { id: 'list.copy', keys: ['y', 'y'], command: 'list.copy', surfaces: LIST_LIKE },
  { id: 'list.delete', keys: ['d', 'd'], command: 'list.delete', surfaces: LIST_LIKE },
  { id: 'surface.escape', keys: ['escape'], command: 'surface.escape', surfaces: LIST_LIKE },

  // -- tabs / activity bar / view container tabs -----------------------------
  {
    id: 'surface.previous.h',
    keys: ['h'],
    command: 'surface.previous',
    surfaces: CHROME_LIKE,
  },
  {
    id: 'surface.previous.k',
    keys: ['k'],
    command: 'surface.previous',
    surfaces: CHROME_LIKE,
  },
  { id: 'surface.next.l', keys: ['l'], command: 'surface.next', surfaces: CHROME_LIKE },
  { id: 'surface.next.j', keys: ['j'], command: 'surface.next', surfaces: CHROME_LIKE },
  {
    id: 'surface.activate',
    keys: ['enter'],
    command: 'list.activate',
    surfaces: CHROME_LIKE,
  },
  { id: 'surface.remove', keys: ['x'], command: 'list.delete', surfaces: CHROME_LIKE },
  { id: 'surface.toggle', keys: ['p'], command: 'list.toggle', surfaces: CHROME_LIKE },
  {
    id: 'surface.escape.chrome',
    keys: ['escape'],
    command: 'surface.escape',
    surfaces: CHROME_LIKE,
  },

  // -- terminal normal mode ---------------------------------------------------
  {
    id: 'terminal.scrollLineDown',
    keys: ['j'],
    command: 'workbench.action.terminal.normalScrollLineDown',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollLineUp',
    keys: ['k'],
    command: 'workbench.action.terminal.normalScrollLineUp',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollHalfPageDown',
    keys: ['ctrl+d'],
    command: 'workbench.action.terminal.normalScrollHalfPageDown',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollHalfPageUp',
    keys: ['ctrl+u'],
    command: 'workbench.action.terminal.normalScrollHalfPageUp',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollPageDown',
    keys: ['ctrl+f'],
    command: 'workbench.action.terminal.normalScrollPageDown',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollPageUp',
    keys: ['ctrl+b'],
    command: 'workbench.action.terminal.normalScrollPageUp',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollToTop',
    keys: ['g', 'g'],
    command: 'workbench.action.terminal.normalScrollToTop',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.scrollToBottom',
    keys: ['G'],
    command: 'workbench.action.terminal.normalScrollToBottom',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.startSelection',
    keys: ['v'],
    command: 'workbench.action.terminal.normalStartSelection',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.copySelection',
    keys: ['y'],
    command: 'workbench.action.terminal.normalCopySelection',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.exitNormal.i',
    keys: ['i'],
    command: 'workbench.action.terminal.exitNormalMode',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.exitNormal.escape',
    keys: ['escape'],
    command: 'workbench.action.terminal.exitNormalMode',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.exitNormal.a',
    keys: ['a'],
    command: 'workbench.action.terminal.exitNormalMode',
    surfaces: ['terminal'],
  },
  {
    id: 'terminal.exitNormal.q',
    keys: ['q'],
    command: 'workbench.action.terminal.exitNormalMode',
    surfaces: ['terminal'],
  },

  // -- leader ----------------------------------------------------------------
  { id: 'leader.explorer', keys: ['<leader>', 'e'], command: 'workbench.view.explorer' },
  { id: 'leader.quickOpen', keys: ['<leader>', 'f'], command: 'workbench.action.quickOpen' },
  {
    id: 'leader.showCommands',
    keys: ['<leader>', 'p'],
    command: 'workbench.action.showCommands',
  },
  {
    id: 'leader.findInFiles',
    keys: ['<leader>', 's'],
    command: 'workbench.action.findInFiles',
  },
  { id: 'leader.scm', keys: ['<leader>', 'g'], command: 'workbench.view.scm' },
  { id: 'leader.extensions', keys: ['<leader>', 'x'], command: 'workbench.view.extensions' },
  {
    id: 'leader.sideBar',
    keys: ['<leader>', 'b'],
    command: 'workbench.action.focusSideBar',
  },
  { id: 'leader.panel', keys: ['<leader>', 'j'], command: 'workbench.action.focusPanel' },
  {
    id: 'leader.terminal',
    keys: ['<leader>', 't'],
    command: 'workbench.action.terminal.focus',
  },
  { id: 'leader.outline', keys: ['<leader>', 'o'], command: 'outline.focus' },
  {
    id: 'leader.closeEditor',
    keys: ['<leader>', 'q'],
    command: 'workbench.action.closeActiveEditor',
  },
  {
    id: 'leader.nextEditor',
    keys: ['<leader>', 'n'],
    command: 'workbench.action.nextEditor',
  },
  {
    id: 'leader.previousEditor',
    keys: ['<leader>', 'N'],
    command: 'workbench.action.previousEditor',
  },
  {
    id: 'leader.groupLeft',
    keys: ['<leader>', 'w', 'h'],
    command: 'workbench.action.focusLeftGroup',
  },
  {
    id: 'leader.groupDown',
    keys: ['<leader>', 'w', 'j'],
    command: 'workbench.action.focusBelowGroup',
  },
  {
    id: 'leader.groupUp',
    keys: ['<leader>', 'w', 'k'],
    command: 'workbench.action.focusAboveGroup',
  },
  {
    id: 'leader.groupRight',
    keys: ['<leader>', 'w', 'l'],
    command: 'workbench.action.focusRightGroup',
  },
  {
    id: 'leader.groupWrap',
    keys: ['<leader>', 'w', 'w'],
    command: 'workbench.action.focusNextGroup',
  },
  {
    id: 'leader.split',
    keys: ['<leader>', 'w', 's'],
    command: 'workbench.action.splitEditorDown',
  },
  {
    id: 'leader.closeGroup',
    keys: ['<leader>', 'w', 'c'],
    command: 'workbench.action.closeActiveEditor',
  },
]
