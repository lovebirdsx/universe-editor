/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/command/
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CommandsRegistry } from '../../command/commandRegistry.js'
import { MenuId, MenuRegistry } from '../../command/menuRegistry.js'
import { KeybindingsRegistry } from '../../command/keybindingRegistry.js'
import { ContextKeyService } from '../../command/contextKey.js'

// Need a fresh registry for each test to avoid cross-test interference.
// CommandsRegistry is a singleton, so tests share state.

describe('CommandsRegistry', () => {
  it('registers and retrieves a command', () => {
    const handler = vi.fn()
    const d = CommandsRegistry.registerCommand('test.cmd1', handler)
    const cmd = CommandsRegistry.getCommand('test.cmd1')
    expect(cmd).toBeDefined()
    expect(cmd?.id).toBe('test.cmd1')
    d.dispose()
  })

  it('unregistering removes the command', () => {
    const d = CommandsRegistry.registerCommand('test.cmd2', vi.fn())
    d.dispose()
    expect(CommandsRegistry.getCommand('test.cmd2')).toBeUndefined()
  })

  it('later registrations take priority (stack semantics)', () => {
    const handler1 = vi.fn().mockReturnValue('first')
    const handler2 = vi.fn().mockReturnValue('second')

    const d1 = CommandsRegistry.registerCommand('test.cmd3', handler1)
    const d2 = CommandsRegistry.registerCommand('test.cmd3', handler2)

    const cmd = CommandsRegistry.getCommand('test.cmd3')
    expect(cmd?.handler).toBe(handler2)

    d2.dispose()
    d1.dispose()
  })

  it('getCommands returns all registered commands', () => {
    const d = CommandsRegistry.registerCommand('test.cmd4', vi.fn())
    const commands = CommandsRegistry.getCommands()
    expect(commands.has('test.cmd4')).toBe(true)
    d.dispose()
  })

  it('supports metadata', () => {
    const d = CommandsRegistry.registerCommand('test.cmd5', vi.fn(), {
      description: 'A test command',
      category: 'Test',
    })
    const cmd = CommandsRegistry.getCommand('test.cmd5')
    expect(cmd?.metadata?.description).toBe('A test command')
    d.dispose()
  })
})

describe('MenuRegistry', () => {
  it('registers and retrieves menu items', () => {
    const d = MenuRegistry.addMenuItem(MenuId.CommandPalette, {
      command: 'test.menu1',
      group: 'navigation',
    })
    const items = MenuRegistry.getMenuItems(MenuId.CommandPalette)
    expect(items.some((i) => i.command === 'test.menu1')).toBe(true)
    d.dispose()
  })

  it('unregistering removes the item', () => {
    const d = MenuRegistry.addMenuItem(MenuId.EditorTitle, {
      command: 'test.menu2',
    })
    d.dispose()
    const items = MenuRegistry.getMenuItems(MenuId.EditorTitle)
    expect(items.some((i) => i.command === 'test.menu2')).toBe(false)
  })

  it('items are sorted by group then order', () => {
    const d1 = MenuRegistry.addMenuItem(MenuId.TitleBar, {
      command: 'z-cmd',
      group: 'b',
      order: 2,
    })
    const d2 = MenuRegistry.addMenuItem(MenuId.TitleBar, {
      command: 'a-cmd',
      group: 'a',
      order: 1,
    })
    const d3 = MenuRegistry.addMenuItem(MenuId.TitleBar, {
      command: 'b-cmd',
      group: 'b',
      order: 1,
    })

    const items = MenuRegistry.getMenuItems(MenuId.TitleBar).filter((i) =>
      ['a-cmd', 'b-cmd', 'z-cmd'].includes(i.command),
    )

    expect(items.map((i) => i.command)).toEqual(['a-cmd', 'b-cmd', 'z-cmd'])

    d1.dispose()
    d2.dispose()
    d3.dispose()
  })

  it('fires onDidChangeMenu when item is added', () => {
    const spy = vi.fn()
    const sub = MenuRegistry.onDidChangeMenu(spy)
    const d = MenuRegistry.addMenuItem(MenuId.StatusBar, { command: 'x' })
    expect(spy).toHaveBeenCalled()
    d.dispose()
    sub.dispose()
  })
})

describe('KeybindingsRegistry', () => {
  it('registers and resolves a keybinding', () => {
    const d = KeybindingsRegistry.registerKeybinding({
      key: 'ctrl+k',
      command: 'test.keybind1',
    })
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+k')).toBe('test.keybind1')
    d.dispose()
  })

  it('normalizes key format', () => {
    const d = KeybindingsRegistry.registerKeybinding({
      key: 'SHIFT+CTRL+P',
      command: 'test.keybind2',
    })
    // Normalized: ctrl+shift+p
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+p')).toBe('test.keybind2')
    d.dispose()
  })

  it('unregistering removes the binding', () => {
    const d = KeybindingsRegistry.registerKeybinding({
      key: 'f5',
      command: 'test.keybind3',
    })
    d.dispose()
    expect(KeybindingsRegistry.resolveKeybinding('f5')).toBeUndefined()
  })

  it('newer registration takes priority', () => {
    const d1 = KeybindingsRegistry.registerKeybinding({ key: 'f6', command: 'first' })
    const d2 = KeybindingsRegistry.registerKeybinding({ key: 'f6', command: 'second' })
    expect(KeybindingsRegistry.resolveKeybinding('f6')).toBe('second')
    d2.dispose()
    d1.dispose()
  })
})

describe('ContextKeyService', () => {
  it('sets and gets a key', () => {
    const svc = new ContextKeyService()
    svc.set('myKey', 'hello')
    expect(svc.get('myKey')).toBe('hello')
    svc.dispose()
  })

  it('evaluate: bare key truthy check', () => {
    const svc = new ContextKeyService()
    svc.set('isReady', true)
    expect(svc.evaluate('isReady')).toBe(true)
    svc.set('isReady', false)
    expect(svc.evaluate('isReady')).toBe(false)
    svc.dispose()
  })

  it('evaluate: equality check', () => {
    const svc = new ContextKeyService()
    svc.set('lang', 'json')
    expect(svc.evaluate("lang == 'json'")).toBe(true)
    expect(svc.evaluate("lang == 'lua'")).toBe(false)
    svc.dispose()
  })

  it('evaluate: inequality check', () => {
    const svc = new ContextKeyService()
    svc.set('lang', 'json')
    expect(svc.evaluate("lang != 'lua'")).toBe(true)
    svc.dispose()
  })

  it('evaluate: negation', () => {
    const svc = new ContextKeyService()
    svc.set('focused', false)
    expect(svc.evaluate('!focused')).toBe(true)
    svc.dispose()
  })

  it('remove() deletes a key', () => {
    const svc = new ContextKeyService()
    svc.set('x', 1)
    svc.remove('x')
    expect(svc.get('x')).toBeUndefined()
    svc.dispose()
  })

  it('createScoped() inherits parent keys', () => {
    const parent = new ContextKeyService()
    parent.set('parentKey', 'yes')
    const scoped = parent.createScoped()
    expect(scoped.get('parentKey')).toBe('yes')
    scoped.dispose()
    parent.dispose()
  })

  it('createScoped() overrides parent keys', () => {
    const parent = new ContextKeyService()
    parent.set('color', 'red')
    const scoped = parent.createScoped({ color: 'blue' })
    expect(scoped.get('color')).toBe('blue')
    scoped.dispose()
    parent.dispose()
  })

  it('fires onDidChangeContext when value changes', () => {
    const svc = new ContextKeyService()
    const spy = vi.fn()
    svc.onDidChangeContext(spy)
    svc.set('x', 42)
    expect(spy).toHaveBeenCalledOnce()
    svc.dispose()
  })
})

describe('MenuRegistry — when filtering', () => {
  it('filters items whose when-clause evaluates to false', () => {
    const svc = new ContextKeyService()
    svc.set('isVisible', true)
    const d1 = MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
      command: 'when.test.visible',
      when: 'isVisible',
    })
    const d2 = MenuRegistry.addMenuItem(MenuId.MenubarViewMenu, {
      command: 'when.test.hidden',
      when: '!isVisible',
    })

    const items = MenuRegistry.getMenuItems(MenuId.MenubarViewMenu, svc).map((i) => i.command)
    expect(items).toContain('when.test.visible')
    expect(items).not.toContain('when.test.hidden')

    d1.dispose()
    d2.dispose()
    svc.dispose()
  })

  it('without contextKeyService returns all items (backward compat)', () => {
    const d1 = MenuRegistry.addMenuItem(MenuId.MenubarFileMenu, {
      command: 'when.compat.a',
      when: 'never',
    })
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu).map((i) => i.command)
    expect(items).toContain('when.compat.a')
    d1.dispose()
  })
})

describe('KeybindingsRegistry — when filtering', () => {
  it('resolveKeybinding picks the binding whose when matches', () => {
    const svc = new ContextKeyService()
    svc.set('mode', 'edit')
    const d1 = KeybindingsRegistry.registerKeybinding({
      key: 'ctrl+w',
      command: 'cmd.edit',
      when: "mode == 'edit'",
    })
    const d2 = KeybindingsRegistry.registerKeybinding({
      key: 'ctrl+w',
      command: 'cmd.view',
      when: "mode == 'view'",
    })
    // newer-first iteration: cmd.view registered last, but its when fails →
    // falls back to cmd.edit.
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+w', svc)).toBe('cmd.edit')
    svc.set('mode', 'view')
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+w', svc)).toBe('cmd.view')
    d2.dispose()
    d1.dispose()
    svc.dispose()
  })

  it('without contextKeyService preserves legacy behaviour', () => {
    const d1 = KeybindingsRegistry.registerKeybinding({
      key: 'ctrl+y',
      command: 'cmd.legacy',
      when: 'something',
    })
    // No service → when-clause ignored, binding resolves.
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+y')).toBe('cmd.legacy')
    d1.dispose()
  })
})
