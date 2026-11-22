/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in keymap shape: each chrome surface gets its own directional keys and
 *  the scoped entries (`when`) that only fire on one view.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { VIM_DEFAULT_KEYMAP } from '../keybinding/vim/vimDefaultKeymap.js'
import type { IVimKeymapEntry, VimSurfaceKind } from '../keybinding/vim/vimTypes.js'

function entriesFor(kind: VimSurfaceKind, keys: readonly string[]): IVimKeymapEntry[] {
  return VIM_DEFAULT_KEYMAP.filter(
    (entry) =>
      (entry.surfaces === undefined || entry.surfaces.includes(kind)) &&
      entry.keys.length === keys.length &&
      entry.keys.every((key, index) => key === keys[index]),
  )
}

function commandFor(kind: VimSurfaceKind, keys: readonly string[]): string | undefined {
  return entriesFor(kind, keys)[0]?.command
}

describe('VIM_DEFAULT_KEYMAP', () => {
  it('splits tabs: h/l move, 0/gg and $/G jump, x/p/m/Enter act', () => {
    expect(commandFor('tabs', ['h'])).toBe('surface.previous')
    expect(commandFor('tabs', ['l'])).toBe('surface.next')
    expect(commandFor('tabs', ['0'])).toBe('list.focusFirst')
    expect(commandFor('tabs', ['g', 'g'])).toBe('list.focusFirst')
    expect(commandFor('tabs', ['$'])).toBe('list.focusLast')
    expect(commandFor('tabs', ['G'])).toBe('list.focusLast')
    expect(commandFor('tabs', ['enter'])).toBe('list.activate')
    expect(commandFor('tabs', ['x'])).toBe('list.delete')
    expect(commandFor('tabs', ['p'])).toBe('list.toggle')
    expect(commandFor('tabs', ['m'])).toBe('list.contextMenu')
    expect(commandFor('tabs', ['escape'])).toBe('surface.escape')
  })

  it('activity bar: j/k move the cursor, Enter/l open, gg/G jump', () => {
    expect(commandFor('activityBar', ['j'])).toBe('surface.next')
    expect(commandFor('activityBar', ['k'])).toBe('surface.previous')
    expect(commandFor('activityBar', ['enter'])).toBe('list.activate')
    expect(commandFor('activityBar', ['l'])).toBe('list.activate')
    expect(commandFor('activityBar', ['g', 'g'])).toBe('list.focusFirst')
    expect(commandFor('activityBar', ['G'])).toBe('list.focusLast')
  })

  it('view container tabs: h/l switch, Enter/j focus content, gg/G jump', () => {
    expect(commandFor('viewContainerTabs', ['h'])).toBe('surface.previous')
    expect(commandFor('viewContainerTabs', ['l'])).toBe('surface.next')
    expect(commandFor('viewContainerTabs', ['enter'])).toBe('list.activate')
    expect(commandFor('viewContainerTabs', ['j'])).toBe('list.activate')
    expect(commandFor('viewContainerTabs', ['g', 'g'])).toBe('list.focusFirst')
    expect(commandFor('viewContainerTabs', ['G'])).toBe('list.focusLast')
    expect(commandFor('viewContainerTabs', ['escape'])).toBe('surface.escape')
  })

  it('x dismisses the focused notification on overlays but stays unbound on lists', () => {
    expect(commandFor('overlay', ['x'])).toBe('list.delete')
    expect(commandFor('list', ['x'])).toBeUndefined()
  })

  it('settings-only `/` focuses the settings search box', () => {
    const entries = entriesFor('list', ['/'])
    expect(entries.map((entry) => entry.command)).toContain('workbench.action.focusSettingsSearch')
    const entry = entries.find((candidate) => candidate.command.includes('focusSettingsSearch'))
    expect(entry?.when).toContain("vimSurfaceId == 'list:settings'")
    expect(entry?.when).toContain("vimSurfaceId == 'list:settings-toc'")
  })

  it('chat-only i/a/e/j/k map to the existing agent commands while acpChatFocused', () => {
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['i', 'workbench.action.agent.focusInput'],
      ['a', 'workbench.action.agent.scrollTimelineToTop'],
      ['e', 'workbench.action.agent.scrollTimelineToBottom'],
      ['j', 'workbench.action.agent.scrollTimelineDown'],
      ['k', 'workbench.action.agent.scrollTimelineUp'],
    ]
    for (const [key, command] of expectations) {
      const entries = entriesFor('list', [key])
      const entry = entries.find((candidate) => candidate.command === command)
      expect(entry, `${key} -> ${command}`).toBeDefined()
      expect(entry?.when).toBe('acpChatFocused')
    }
  })

  it('navigates compare-editor hunks from a list while a diff is visible', () => {
    for (const [keys, command] of [
      [[']', 'c'], 'workbench.action.compareEditor.nextChange'],
      [['[', 'c'], 'workbench.action.compareEditor.previousChange'],
    ] as const) {
      const entry = entriesFor('list', keys).find((candidate) => candidate.command === command)
      expect(entry, keys.join(' ')).toBeDefined()
      expect(entry?.when).toBe('textCompareEditorVisible')
      expect(commandFor('menu', keys)).toBeUndefined()
      expect(commandFor('editor', keys)).toBeUndefined()
    }
  })

  it('scrolls list/overlay viewports with Ctrl+e/y but leaves menus alone', () => {
    for (const kind of ['list', 'overlay'] as const) {
      expect(commandFor(kind, ['ctrl+e'])).toBe('list.scrollViewportDown')
      expect(commandFor(kind, ['ctrl+y'])).toBe('list.scrollViewportUp')
    }
    expect(commandFor('menu', ['ctrl+e'])).toBeUndefined()
    expect(commandFor('menu', ['ctrl+y'])).toBeUndefined()
  })

  it('scrolls terminal normal mode lines with Ctrl+e/y', () => {
    expect(commandFor('terminal', ['ctrl+e'])).toBe(
      'workbench.action.terminal.normalScrollLineDown',
    )
    expect(commandFor('terminal', ['ctrl+y'])).toBe('workbench.action.terminal.normalScrollLineUp')
  })

  it('editor leader aliases stay on the editor surface', () => {
    const expectations = [
      [['<leader>', 'd'], 'editor.action.revealDefinition'],
      [['<leader>', 'D'], 'editor.action.peekDefinition'],
      [['<leader>', 'r'], 'editor.action.goToReferences'],
      [['<leader>', 'R'], 'editor.action.referenceSearch.trigger'],
      [['<leader>', 'y'], 'editor.action.goToTypeDefinition'],
      [['<leader>', 'i'], 'editor.action.goToImplementation'],
      [['<leader>', 'k'], 'editor.action.showHover'],
      [['<leader>', 'a'], 'editor.action.quickFix'],
      [['<leader>', 'c'], 'editor.action.commentLine'],
      [['<leader>', 'm'], 'editor.action.rename'],
      [['<leader>', 'F'], 'editor.action.formatDocument'],
      [['<leader>', 'I'], 'editor.action.organizeImports'],
      [['<leader>', 'G'], 'editor.action.gotoLine'],
      [['<leader>', 'O'], 'editor.action.quickOutline'],
      [['<leader>', 'S'], 'workbench.action.showAllSymbols'],
      [['<leader>', 'h'], 'workbench.action.goBack'],
      [['<leader>', 'l'], 'workbench.action.goForward'],
    ] as const
    for (const [keys, command] of expectations) {
      expect(commandFor('editor', keys), keys.join(' ')).toBe(command)
      expect(commandFor('list', keys), keys.join(' ')).toBeUndefined()
    }
  })
})
