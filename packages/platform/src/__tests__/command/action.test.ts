/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/command/action.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CommandsRegistry } from '../../command/commandRegistry.js'
import { ContextKeyService } from '../../command/contextKey.js'
import { Action2, registerAction2 } from '../../command/action.js'
import { KeybindingsRegistry } from '../../command/keybindingRegistry.js'
import { type IMenuItem, MenuId, MenuRegistry } from '../../command/menuRegistry.js'

class SimpleAction extends Action2 {
  static readonly ID = 'test.action.simple'
  static runSpy = vi.fn()
  constructor() {
    super({
      id: SimpleAction.ID,
      title: 'Simple Action',
      category: 'Test',
      keybinding: { primary: 'ctrl+alt+s' },
      menu: { id: MenuId.MenubarViewMenu, group: 'tests', order: 1 },
      f1: true,
    })
  }
  override run(): void {
    SimpleAction.runSpy()
  }
}

class PreconditionedAction extends Action2 {
  static readonly ID = 'test.action.pre'
  constructor() {
    super({
      id: PreconditionedAction.ID,
      title: 'Preconditioned',
      precondition: 'isReady',
      menu: { id: MenuId.MenubarFileMenu, when: "lang == 'json'" },
      keybinding: { primary: 'ctrl+alt+r', when: 'editorFocused' },
    })
  }
  override run(): void {}
}

class MultiTargetAction extends Action2 {
  static readonly ID = 'test.action.multi'
  constructor() {
    super({
      id: MultiTargetAction.ID,
      title: 'Multi',
      menu: [
        { id: MenuId.MenubarEditMenu, order: 1 },
        { id: MenuId.MenubarViewMenu, order: 2 },
      ],
      keybinding: [{ primary: 'ctrl+alt+1' }, { primary: 'ctrl+alt+2' }],
    })
  }
  override run(): void {}
}

class LocalizedAction extends Action2 {
  static readonly ID = 'test.action.localized'
  constructor() {
    super({
      id: LocalizedAction.ID,
      title: { value: '简单动作', original: 'Simple Action' },
      category: { value: '测试', original: 'Test' },
      f1: true,
    })
  }
  override run(): void {}
}

describe('Action2 / registerAction2', () => {
  it('registers a command, menu, keybinding and command palette entry', () => {
    const d = registerAction2(SimpleAction)
    try {
      expect(CommandsRegistry.getCommand(SimpleAction.ID)).toBeDefined()
      expect(CommandsRegistry.getCommand(SimpleAction.ID)?.metadata?.category).toBe('Test')
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+s')).toBe(SimpleAction.ID)
      const viewItems = MenuRegistry.getMenuItems(MenuId.MenubarViewMenu)
        .filter((i): i is IMenuItem => 'command' in i)
        .map((i) => i.command)
      expect(viewItems).toContain(SimpleAction.ID)
      const paletteItems = MenuRegistry.getMenuItems(MenuId.CommandPalette)
        .filter((i): i is IMenuItem => 'command' in i)
        .map((i) => i.command)
      expect(paletteItems).toContain(SimpleAction.ID)
    } finally {
      d.dispose()
    }
  })

  it('handler delegates to action.run', async () => {
    SimpleAction.runSpy.mockReset()
    const d = registerAction2(SimpleAction)
    try {
      const cmd = CommandsRegistry.getCommand(SimpleAction.ID)
      // ServicesAccessor isn't needed for SimpleAction.run; pass a stub.
      cmd?.handler({ get: () => undefined as unknown } as never)
      expect(SimpleAction.runSpy).toHaveBeenCalledOnce()
    } finally {
      d.dispose()
    }
  })

  it('precondition is ANDed with menu.when', () => {
    const d = registerAction2(PreconditionedAction)
    try {
      const svc = new ContextKeyService()
      const fileCommands = (): string[] =>
        MenuRegistry.getMenuItems(MenuId.MenubarFileMenu, svc)
          .filter((i): i is IMenuItem => 'command' in i)
          .map((i) => i.command)
      // Both keys missing: must not pass.
      let items = fileCommands()
      expect(items).not.toContain(PreconditionedAction.ID)

      svc.set('isReady', true)
      items = fileCommands()
      expect(items).not.toContain(PreconditionedAction.ID)

      svc.set('lang', 'json')
      items = fileCommands()
      expect(items).toContain(PreconditionedAction.ID)
      svc.dispose()
    } finally {
      d.dispose()
    }
  })

  it('precondition is ANDed with keybinding.when', () => {
    const d = registerAction2(PreconditionedAction)
    try {
      const svc = new ContextKeyService()
      svc.set('isReady', true)
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+r', svc)).toBeUndefined()
      svc.set('editorFocused', true)
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+r', svc)).toBe(PreconditionedAction.ID)
      svc.dispose()
    } finally {
      d.dispose()
    }
  })

  it('supports multiple menus and keybindings', () => {
    const d = registerAction2(MultiTargetAction)
    try {
      expect(
        MenuRegistry.getMenuItems(MenuId.MenubarEditMenu).some(
          (i) => 'command' in i && i.command === MultiTargetAction.ID,
        ),
      ).toBe(true)
      expect(
        MenuRegistry.getMenuItems(MenuId.MenubarViewMenu).some(
          (i) => 'command' in i && i.command === MultiTargetAction.ID,
        ),
      ).toBe(true)
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+1')).toBe(MultiTargetAction.ID)
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+2')).toBe(MultiTargetAction.ID)
    } finally {
      d.dispose()
    }
  })

  it('stores the localized title and the original English form in command metadata', () => {
    const d = registerAction2(LocalizedAction)
    try {
      const meta = CommandsRegistry.getCommand(LocalizedAction.ID)?.metadata
      expect(meta?.description).toBe('简单动作')
      expect(meta?.originalDescription).toBe('Simple Action')
      expect(meta?.category).toBe('测试')
      expect(meta?.originalCategory).toBe('Test')
    } finally {
      d.dispose()
    }
  })

  it('leaves original fields undefined for plain string titles', () => {
    const d = registerAction2(SimpleAction)
    try {
      const meta = CommandsRegistry.getCommand(SimpleAction.ID)?.metadata
      expect(meta?.description).toBe('Simple Action')
      expect(meta?.originalDescription).toBeUndefined()
      expect(meta?.originalCategory).toBeUndefined()
    } finally {
      d.dispose()
    }
  })

  it('dispose unregisters everything', () => {
    const d = registerAction2(SimpleAction)
    d.dispose()
    expect(CommandsRegistry.getCommand(SimpleAction.ID)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+s')).toBeUndefined()
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarViewMenu).some(
        (i) => 'command' in i && i.command === SimpleAction.ID,
      ),
    ).toBe(false)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === SimpleAction.ID,
      ),
    ).toBe(false)
  })
})
