/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Application half of the built-in Vim keymap. `@universe-editor/workbench-ui`
 *  ships the generic navigation table (`list.*` / `surface.*`); everything that
 *  names a workbench command or a context key lives here: leader chords, the
 *  editor's leader aliases, terminal Normal mode, the compare-editor hunk keys
 *  and the chat timeline. Views that only need an extra key of their own
 *  (settings `/`, graph search) declare it on their surface instead — see
 *  `IVimSurfaceRegistration.keymap`.
 *
 *  Same token rules as the default table: `<leader>` is replaced by the
 *  configured leader, printable keys keep their case.
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'

type Row = readonly [id: string, keys: readonly string[], command: string]

function surfaceRows(
  surface: 'terminal' | 'editor',
  rows: readonly Row[],
): readonly IVimKeymapEntry[] {
  return rows.map(([id, keys, command]) => ({ id, keys, command, surfaces: [surface] }))
}

const LEADER_ENTRIES: readonly IVimKeymapEntry[] = (
  [
    ['leader.explorer', ['<leader>', 'e'], 'workbench.view.explorer'],
    ['leader.quickOpen', ['<leader>', 'f'], 'workbench.action.quickOpen'],
    ['leader.showCommands', ['<leader>', 'p'], 'workbench.action.showCommands'],
    ['leader.findInFiles', ['<leader>', 's'], 'workbench.action.findInFiles'],
    ['leader.scm', ['<leader>', 'g'], 'workbench.view.scm'],
    ['leader.extensions', ['<leader>', 'x'], 'workbench.view.extensions'],
    ['leader.sideBar', ['<leader>', 'b'], 'workbench.action.focusSideBar'],
    ['leader.panel', ['<leader>', 'j'], 'workbench.action.focusPanel'],
    ['leader.terminal', ['<leader>', 't'], 'workbench.action.terminal.focus'],
    ['leader.outline', ['<leader>', 'o'], 'outline.focus'],
    ['leader.closeEditor', ['<leader>', 'q'], 'workbench.action.closeActiveEditor'],
    ['leader.nextEditor', ['<leader>', 'n'], 'workbench.action.nextEditor'],
    ['leader.previousEditor', ['<leader>', 'N'], 'workbench.action.previousEditor'],
    ['leader.groupLeft', ['<leader>', 'w', 'h'], 'workbench.action.navigateLeft'],
    ['leader.groupDown', ['<leader>', 'w', 'j'], 'workbench.action.navigateDown'],
    ['leader.groupUp', ['<leader>', 'w', 'k'], 'workbench.action.navigateUp'],
    ['leader.groupRight', ['<leader>', 'w', 'l'], 'workbench.action.navigateRight'],
    ['leader.moveEditorLeft', ['<leader>', 'w', 'H'], 'workbench.action.moveEditorToLeftGroup'],
    ['leader.moveEditorBelow', ['<leader>', 'w', 'J'], 'workbench.action.moveEditorToBelowGroup'],
    ['leader.moveEditorAbove', ['<leader>', 'w', 'K'], 'workbench.action.moveEditorToAboveGroup'],
    ['leader.moveEditorRight', ['<leader>', 'w', 'L'], 'workbench.action.moveEditorToRightGroup'],
    ['leader.groupWrap', ['<leader>', 'w', 'w'], 'workbench.action.focusNextGroup'],
    ['leader.split', ['<leader>', 'w', 's'], 'workbench.action.splitEditorDown'],
    ['leader.splitRight', ['<leader>', 'w', 'v'], 'workbench.action.splitEditorRight'],
    ['leader.closeGroup', ['<leader>', 'w', 'c'], 'workbench.action.closeEditorsInGroup'],
    ['leader.cheatSheet', ['<leader>', '?'], 'workbench.action.vim.showKeymapCheatSheet'],
  ] satisfies readonly Row[]
).map(([id, keys, command]) => ({ id, keys, command }))

// The native keys (`gd`, `gr`, ...) live in the editor Vim core; these leader
// entries are the discoverable aliases and the only way to reach the actions
// that have no native mapping.
const EDITOR_ENTRIES = surfaceRows('editor', [
  ['editor.definition', ['<leader>', 'd'], 'editor.action.revealDefinition'],
  ['editor.peekDefinition', ['<leader>', 'D'], 'editor.action.peekDefinition'],
  ['editor.references', ['<leader>', 'r'], 'editor.action.goToReferences'],
  ['editor.peekReferences', ['<leader>', 'R'], 'editor.action.referenceSearch.trigger'],
  ['editor.typeDefinition', ['<leader>', 'y'], 'editor.action.goToTypeDefinition'],
  ['editor.implementation', ['<leader>', 'i'], 'editor.action.goToImplementation'],
  ['editor.hover', ['<leader>', 'k'], 'editor.action.showHover'],
  ['editor.quickFix', ['<leader>', 'a'], 'editor.action.quickFix'],
  ['editor.comment', ['<leader>', 'c'], 'editor.action.commentLine'],
  ['editor.rename', ['<leader>', 'm'], 'editor.action.rename'],
  ['editor.format', ['<leader>', 'F'], 'editor.action.formatDocument'],
  ['editor.organizeImports', ['<leader>', 'I'], 'editor.action.organizeImports'],
  ['editor.gotoLine', ['<leader>', 'G'], 'editor.action.gotoLine'],
  ['editor.symbols', ['<leader>', 'O'], 'workbench.action.gotoSymbol'],
  ['editor.workspaceSymbols', ['<leader>', 'S'], 'workbench.action.showAllSymbols'],
  ['editor.goBack', ['<leader>', 'h'], 'workbench.action.goBack'],
  ['editor.goForward', ['<leader>', 'l'], 'workbench.action.goForward'],
  ['editor.gotoParentFold', ['<leader>', 'z'], 'editor.gotoParentFold'],
])

// Motion reuses the generic `list.*` commands: the terminal registers a surface
// whose `actions` drive its Normal-mode controller. Only what has no generic
// counterpart keeps a terminal-specific command (Ctrl+F/B full pages, the
// linewise selection and the mode switches).
const TERMINAL_ENTRIES = surfaceRows('terminal', [
  ['terminal.scrollLineDown', ['j'], 'list.focusDown'],
  ['terminal.scrollLineUp', ['k'], 'list.focusUp'],
  ['terminal.scrollViewportDown', ['ctrl+e'], 'list.scrollViewportDown'],
  ['terminal.scrollViewportUp', ['ctrl+y'], 'list.scrollViewportUp'],
  ['terminal.scrollHalfPageDown', ['ctrl+d'], 'list.pageDown'],
  ['terminal.scrollHalfPageUp', ['ctrl+u'], 'list.pageUp'],
  ['terminal.scrollPageDown', ['ctrl+f'], 'workbench.action.terminal.normalScrollPageDown'],
  ['terminal.scrollPageUp', ['ctrl+b'], 'workbench.action.terminal.normalScrollPageUp'],
  ['terminal.scrollToTop', ['g', 'g'], 'list.focusFirst'],
  ['terminal.scrollToBottom', ['G'], 'list.focusLast'],
  ['terminal.startSelection', ['v'], 'workbench.action.terminal.normalStartSelection'],
  ['terminal.copySelection', ['y'], 'workbench.action.terminal.normalCopySelection'],
  ['terminal.exitNormal.i', ['i'], 'workbench.action.terminal.exitNormalMode'],
  ['terminal.exitNormal.escape', ['escape'], 'surface.escape'],
  ['terminal.exitNormal.a', ['a'], 'workbench.action.terminal.exitNormalMode'],
  ['terminal.exitNormal.q', ['q'], 'workbench.action.terminal.exitNormalMode'],
])

// Chat timeline: only while the chat owns DOM focus, so the same letters stay
// inert on other lists (and the prompt input still types them).
const CHAT_ENTRIES: readonly IVimKeymapEntry[] = (
  [
    ['chat.focusInput', 'i', 'workbench.action.agent.focusInput'],
    ['chat.scrollTimelineToTop', 'a', 'workbench.action.agent.scrollTimelineToTop'],
    ['chat.scrollTimelineToBottom', 'e', 'workbench.action.agent.scrollTimelineToBottom'],
    ['chat.scrollTimelineDown', 'j', 'workbench.action.agent.scrollTimelineDown'],
    ['chat.scrollTimelineUp', 'k', 'workbench.action.agent.scrollTimelineUp'],
  ] as const
).map(([id, key, command]) => ({
  id,
  keys: [key],
  command,
  surfaces: ['list'],
  when: 'acpChatFocused',
}))

// A diff previewed from a view keeps focus in the list, so the editor
// surface's `]c` / `[c` never sees the stroke there. Route them to the compare
// editor while one is visible; the commands navigate hunks without stealing
// focus back.
const COMPARE_ENTRIES: readonly IVimKeymapEntry[] = [
  {
    id: 'list.nextChange',
    keys: [']', 'c'],
    command: 'workbench.action.compareEditor.nextChange',
    surfaces: ['list'],
    when: 'textCompareEditorVisible',
  },
  {
    id: 'list.previousChange',
    keys: ['[', 'c'],
    command: 'workbench.action.compareEditor.previousChange',
    surfaces: ['list'],
    when: 'textCompareEditorVisible',
  },
]

// Navigation history is workbench-wide, so the jump keys mean the same on every
// Normal surface: from the Explorer `Ctrl+O` returns to the last editor location
// instead of falling through to the global Open File. Menus / overlays excluded.
const NAVIGATION_ENTRIES: readonly IVimKeymapEntry[] = (
  [
    ['nav.back', 'ctrl+o', 'workbench.action.goBack'],
    ['nav.forward', 'ctrl+i', 'workbench.action.goForward'],
  ] as const
).map(([id, key, command]) => ({
  id,
  keys: [key],
  command,
  surfaces: ['editor', 'list', 'reader', 'tabs', 'activityBar', 'viewContainerTabs', 'terminal'],
}))

export const VIM_APP_KEYMAP: readonly IVimKeymapEntry[] = [
  ...NAVIGATION_ENTRIES,
  ...COMPARE_ENTRIES,
  ...CHAT_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...LEADER_ENTRIES,
  ...EDITOR_ENTRIES,
]
