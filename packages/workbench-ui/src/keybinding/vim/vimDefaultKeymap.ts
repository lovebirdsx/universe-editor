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
 *
 *  Only the generic navigation vocabulary lives here (`list.*` / `surface.*`
 *  commands for lists, menus, overlays, readers and the chrome strips). Entries
 *  naming application commands (leader chords, terminal, chat, views with their
 *  own search box) belong to the host app's keymap; a view's own keys are
 *  declared on its surface (`IVimSurfaceRegistration.keymap`).
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry, VimSurfaceKind } from './vimTypes.js'

const LIST_LIKE: readonly VimSurfaceKind[] = ['list', 'menu', 'overlay']
/**
 * Read-only readers (markdown preview) take the motion keys only; Enter, `o`,
 * `dd`... stay unbound there so the content's own keys keep working.
 */
const MOTION: readonly VimSurfaceKind[] = ['list', 'menu', 'overlay', 'reader']
/** Menus have no vertical viewport of their own, so no `Ctrl+E/Y` there. */
const SCROLLABLE: readonly VimSurfaceKind[] = ['list', 'overlay', 'reader']

export const VIM_DEFAULT_KEYMAP: readonly IVimKeymapEntry[] = [
  // -- lists, menus, overlays -------------------------------------------------
  { id: 'list.focusDown', keys: ['j'], command: 'list.focusDown', surfaces: MOTION },
  { id: 'list.focusUp', keys: ['k'], command: 'list.focusUp', surfaces: MOTION },
  { id: 'list.focusLeft', keys: ['h'], command: 'list.focusLeft', surfaces: MOTION },
  { id: 'list.focusRight', keys: ['l'], command: 'list.focusRight', surfaces: MOTION },
  { id: 'list.focusFirst', keys: ['g', 'g'], command: 'list.focusFirst', surfaces: MOTION },
  { id: 'list.focusLast', keys: ['G'], command: 'list.focusLast', surfaces: MOTION },
  {
    id: 'list.pageDown',
    keys: ['ctrl+d'],
    command: 'list.pageDown',
    surfaces: MOTION,
  },
  { id: 'list.pageUp', keys: ['ctrl+u'], command: 'list.pageUp', surfaces: MOTION },
  {
    id: 'list.scrollViewportDown',
    keys: ['ctrl+e'],
    command: 'list.scrollViewportDown',
    surfaces: SCROLLABLE,
  },
  {
    id: 'list.scrollViewportUp',
    keys: ['ctrl+y'],
    command: 'list.scrollViewportUp',
    surfaces: SCROLLABLE,
  },
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
  // Only trees that own a filter box implement `find`; elsewhere it is a no-op.
  { id: 'list.find', keys: ['/'], command: 'list.find', surfaces: ['list'] },
  { id: 'list.copy', keys: ['y', 'y'], command: 'list.copy', surfaces: LIST_LIKE },
  { id: 'list.delete', keys: ['d', 'd'], command: 'list.delete', surfaces: LIST_LIKE },
  { id: 'surface.escape', keys: ['escape'], command: 'surface.escape', surfaces: LIST_LIKE },

  // -- overlay: x dismisses the focused notification --------------------------
  { id: 'overlay.delete', keys: ['x'], command: 'list.delete', surfaces: ['overlay'] },

  // -- editor tabs ------------------------------------------------------------
  { id: 'tabs.previous', keys: ['h'], command: 'surface.previous', surfaces: ['tabs'] },
  { id: 'tabs.next', keys: ['l'], command: 'surface.next', surfaces: ['tabs'] },
  { id: 'tabs.first.0', keys: ['0'], command: 'list.focusFirst', surfaces: ['tabs'] },
  { id: 'tabs.first.gg', keys: ['g', 'g'], command: 'list.focusFirst', surfaces: ['tabs'] },
  { id: 'tabs.last.$', keys: ['$'], command: 'list.focusLast', surfaces: ['tabs'] },
  { id: 'tabs.last.G', keys: ['G'], command: 'list.focusLast', surfaces: ['tabs'] },
  { id: 'tabs.activate', keys: ['enter'], command: 'list.activate', surfaces: ['tabs'] },
  { id: 'tabs.remove', keys: ['x'], command: 'list.delete', surfaces: ['tabs'] },
  { id: 'tabs.toggle', keys: ['p'], command: 'list.toggle', surfaces: ['tabs'] },
  { id: 'tabs.contextMenu', keys: ['m'], command: 'list.contextMenu', surfaces: ['tabs'] },
  { id: 'tabs.escape', keys: ['escape'], command: 'surface.escape', surfaces: ['tabs'] },

  // -- activity bar -----------------------------------------------------------
  {
    id: 'activityBar.next',
    keys: ['j'],
    command: 'surface.next',
    surfaces: ['activityBar'],
  },
  {
    id: 'activityBar.previous',
    keys: ['k'],
    command: 'surface.previous',
    surfaces: ['activityBar'],
  },
  {
    id: 'activityBar.activate.enter',
    keys: ['enter'],
    command: 'list.activate',
    surfaces: ['activityBar'],
  },
  {
    id: 'activityBar.activate.l',
    keys: ['l'],
    command: 'list.activate',
    surfaces: ['activityBar'],
  },
  {
    id: 'activityBar.first',
    keys: ['g', 'g'],
    command: 'list.focusFirst',
    surfaces: ['activityBar'],
  },
  {
    id: 'activityBar.last',
    keys: ['G'],
    command: 'list.focusLast',
    surfaces: ['activityBar'],
  },

  // -- view container tabs ----------------------------------------------------
  {
    id: 'viewContainerTabs.previous',
    keys: ['h'],
    command: 'surface.previous',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.next',
    keys: ['l'],
    command: 'surface.next',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.activate.enter',
    keys: ['enter'],
    command: 'list.activate',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.activate.j',
    keys: ['j'],
    command: 'list.activate',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.first',
    keys: ['g', 'g'],
    command: 'list.focusFirst',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.last',
    keys: ['G'],
    command: 'list.focusLast',
    surfaces: ['viewContainerTabs'],
  },
  {
    id: 'viewContainerTabs.escape',
    keys: ['escape'],
    command: 'surface.escape',
    surfaces: ['viewContainerTabs'],
  },
]
