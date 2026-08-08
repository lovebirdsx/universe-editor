import { afterEach, describe, expect, it } from 'vitest'
import {
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  type IDisposable,
} from '@universe-editor/platform'
import { collectKnownContextKeys } from '../knownContextKeys.js'

describe('collectKnownContextKeys', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('includes the statically seeded workbench keys', () => {
    const keys = collectKnownContextKeys().map((c) => c.key)
    expect(keys).toContain('editorTextFocus')
    expect(keys).toContain('hasActiveEditor')
    expect(keys).toContain('sideBarVisible')
    expect(keys).toContain('whenFocus')
  })

  it('includes keys referenced by keybinding when-clauses', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+alt+z',
        command: 'test.ctx.collect',
        when: 'testKbWhenKey && !testKbNegatedKey',
      }),
    )
    const keys = collectKnownContextKeys().map((c) => c.key)
    expect(keys).toContain('testKbWhenKey')
    expect(keys).toContain('testKbNegatedKey')
  })

  it('includes keys referenced by menu-item and submenu when-clauses', () => {
    disposables.push(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'test.ctx.menu',
        when: 'testMenuWhenKey',
      }),
      MenuRegistry.addSubmenuItem(MenuId.MenubarFileMenu, {
        submenu: MenuId.MenubarFileOpenRecentMenu,
        title: 'Test Submenu',
        when: 'testSubmenuWhenKey',
      }),
    )
    const keys = collectKnownContextKeys().map((c) => c.key)
    expect(keys).toContain('testMenuWhenKey')
    expect(keys).toContain('testSubmenuWhenKey')
  })

  it('dedupes across sources and returns a sorted list', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+alt+y',
        command: 'test.ctx.dupe',
        when: 'editorTextFocus', // already a seeded key
      }),
    )
    const keys = collectKnownContextKeys().map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    const sorted = [...keys].sort((a, b) => a.localeCompare(b))
    expect(keys).toEqual(sorted)
  })
})
