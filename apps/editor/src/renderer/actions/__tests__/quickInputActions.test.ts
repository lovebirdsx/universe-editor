/*---------------------------------------------------------------------------------------------
 *  Tests for CloseQuickInputAction. Verifies:
 *   - Registration wires command + ESC keybinding (with the right `when` clause)
 *   - The action is NOT exposed in the command palette (f1 is omitted)
 *   - ContextKey-driven routing: quickInputVisible toggles which `escape`
 *     binding wins against FocusActiveEditorGroupAction
 *   - run() forwards to IQuickInputService.hide()
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IQuickInputService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { CloseQuickInputAction } from '../quickInputActions.js'
import { FocusActiveEditorGroupAction } from '../editorActions.js'

describe('CloseQuickInputAction registration', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers the command', () => {
    disposables.push(registerAction2(CloseQuickInputAction))
    expect(CommandsRegistry.getCommand(CloseQuickInputAction.ID)).toBeDefined()
  })

  it('is NOT exposed in the command palette (f1 omitted)', () => {
    disposables.push(registerAction2(CloseQuickInputAction))
    const inPalette = MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
      (i) => 'command' in i && i.command === CloseQuickInputAction.ID,
    )
    expect(inPalette).toBe(false)
  })

  it('binds escape with when=quickInputVisible', () => {
    disposables.push(registerAction2(CloseQuickInputAction))
    const ctx = new ContextKeyService()
    const visible = ctx.createKey<boolean>('quickInputVisible', false)

    // With key=false → binding's when does not match → no resolution.
    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBeUndefined()

    // Flip → resolves.
    visible.set(true)
    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBe(CloseQuickInputAction.ID)
  })
})

describe('ESC routing via contextKey: CloseQuickInputAction vs FocusActiveEditorGroupAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('routes ESC to CloseQuickInputAction when quickInputVisible=true', () => {
    disposables.push(registerAction2(FocusActiveEditorGroupAction))
    disposables.push(registerAction2(CloseQuickInputAction))
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('hasActiveEditor', true)
    ctx.createKey<boolean>('quickInputVisible', true)

    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBe(CloseQuickInputAction.ID)
  })

  it('routes ESC to FocusActiveEditorGroupAction when quickInputVisible=false', () => {
    disposables.push(registerAction2(FocusActiveEditorGroupAction))
    disposables.push(registerAction2(CloseQuickInputAction))
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('hasActiveEditor', true)
    ctx.createKey<boolean>('quickInputVisible', false)

    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBe(
      FocusActiveEditorGroupAction.ID,
    )
  })

  it('ESC has no match when neither when-clause is satisfied', () => {
    disposables.push(registerAction2(FocusActiveEditorGroupAction))
    disposables.push(registerAction2(CloseQuickInputAction))
    const ctx = new ContextKeyService()
    // hasActiveEditor=false + quickInputVisible=false → both bindings filtered out.
    ctx.createKey<boolean>('hasActiveEditor', false)
    ctx.createKey<boolean>('quickInputVisible', false)

    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBeUndefined()
  })
})

describe('CloseQuickInputAction.run', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('calls IQuickInputService.hide()', () => {
    disposables.push(registerAction2(CloseQuickInputAction))

    const hide = vi.fn()
    const quickInput = {
      _serviceBrand: undefined,
      hide,
      createQuickPick: vi.fn(),
      pick: vi.fn(),
      input: vi.fn(),
    } satisfies IQuickInputService

    const services = new ServiceCollection()
    services.set(IQuickInputService, quickInput)
    const inst = new InstantiationService(services)

    inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(CloseQuickInputAction.ID)!
      cmd.handler(accessor)
    })

    expect(hide).toHaveBeenCalledOnce()
  })
})
