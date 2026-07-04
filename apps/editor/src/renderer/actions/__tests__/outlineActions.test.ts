/*---------------------------------------------------------------------------------------------
 *  Tests for outlineActions — emacs Ctrl+P/N/B/F navigation commands.
 *
 *  The core guarantee: these bindings win the same keystroke over the global
 *  Ctrl+P (quick open) / Ctrl+N (new file) / … *only* when the Outline tree holds
 *  focus (`focusedView == 'workbench.view.outline.main'`), and route to the
 *  currently-registered OutlineNavigatorRegistry navigator.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  OutlineNavigateUpAction,
  OutlineNavigateDownAction,
  OutlineNavigateLeftAction,
  OutlineNavigateRightAction,
} from '../outlineActions.js'
import { OutlineNavigatorRegistry } from '../../workbench/outline/outlineNavigatorRegistry.js'

const OUTLINE_VIEW = 'workbench.view.outline.main'

describe('Outline navigation Action2s', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    OutlineNavigatorRegistry._resetForTests()
  })

  function ctx(focusedView: string): IContextKeyService {
    const svc = new ContextKeyService()
    svc.createKey('focusedView', focusedView)
    return svc
  }

  it('registers command + keybinding for each direction', () => {
    for (const A of [
      OutlineNavigateUpAction,
      OutlineNavigateDownAction,
      OutlineNavigateLeftAction,
      OutlineNavigateRightAction,
    ]) {
      disposables.push(registerAction2(A))
      expect(CommandsRegistry.getCommand(A.ID)).toBeDefined()
    }
  })

  it('Ctrl+P/N/B/F resolve to the outline commands when the outline is focused', () => {
    disposables.push(registerAction2(OutlineNavigateUpAction))
    disposables.push(registerAction2(OutlineNavigateDownAction))
    disposables.push(registerAction2(OutlineNavigateLeftAction))
    disposables.push(registerAction2(OutlineNavigateRightAction))
    const c = ctx(OUTLINE_VIEW)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+p', c)).toBe(OutlineNavigateUpAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+n', c)).toBe(OutlineNavigateDownAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+b', c)).toBe(OutlineNavigateLeftAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+f', c)).toBe(OutlineNavigateRightAction.ID)
  })

  it('does NOT claim Ctrl+P when focus is elsewhere (global quick open wins)', () => {
    disposables.push(registerAction2(OutlineNavigateUpAction))
    const c = ctx('workbench.view.explorer.tree')
    // No other binding registered here → outline binding simply must not match.
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+p', c)).toBeUndefined()
  })

  it('handlers route to the registered navigator', async () => {
    disposables.push(registerAction2(OutlineNavigateUpAction))
    disposables.push(registerAction2(OutlineNavigateDownAction))
    disposables.push(registerAction2(OutlineNavigateLeftAction))
    disposables.push(registerAction2(OutlineNavigateRightAction))
    const navigate = vi.fn()
    OutlineNavigatorRegistry.register({ navigate })

    const inst = new InstantiationService(new ServiceCollection())
    const run = (id: string) =>
      inst.invokeFunction((accessor) => CommandsRegistry.getCommand(id)!.handler(accessor))

    await run(OutlineNavigateUpAction.ID)
    await run(OutlineNavigateDownAction.ID)
    await run(OutlineNavigateLeftAction.ID)
    await run(OutlineNavigateRightAction.ID)
    expect(navigate.mock.calls.map((c) => c[0])).toEqual(['up', 'down', 'left', 'right'])
  })

  it('handler is a no-op when no navigator is registered', () => {
    disposables.push(registerAction2(OutlineNavigateUpAction))
    const inst = new InstantiationService(new ServiceCollection())
    expect(() =>
      inst.invokeFunction((accessor) =>
        CommandsRegistry.getCommand(OutlineNavigateUpAction.ID)!.handler(accessor),
      ),
    ).not.toThrow()
  })
})
