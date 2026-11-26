/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic built-in keymap shape: each chrome surface gets its own directional
 *  keys. Workbench-command entries are covered by `vimAppKeymap.test.ts` in the app.
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

  it('/ opens the host filter on lists only', () => {
    expect(commandFor('list', ['/'])).toBe('list.find')
    for (const kind of ['menu', 'overlay', 'tabs', 'reader'] as const) {
      expect(commandFor(kind, ['/'])).toBeUndefined()
    }
  })

  it('K shows the focused row tooltip on lists only', () => {
    expect(commandFor('list', ['K'])).toBe('list.showHover')
    for (const kind of [
      'menu',
      'overlay',
      'tabs',
      'activityBar',
      'viewContainerTabs',
      'reader',
      'terminal',
    ] as const) {
      expect(commandFor(kind, ['K'])).toBeUndefined()
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
})

describe('VIM_DEFAULT_KEYMAP layering', () => {
  it('names no workbench command and no app context key', () => {
    for (const entry of VIM_DEFAULT_KEYMAP) {
      expect(entry.command, entry.id).toMatch(/^(list|surface)\./)
      expect(entry.when ?? '', entry.id).not.toMatch(
        /acpChatFocused|textCompareEditorVisible|vimSurfaceId/,
      )
    }
  })

  it('has unique ids', () => {
    const ids = VIM_DEFAULT_KEYMAP.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
