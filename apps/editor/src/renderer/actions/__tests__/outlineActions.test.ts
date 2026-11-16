/*---------------------------------------------------------------------------------------------
 *  Tests for outlineActions — user-bindable outline navigation commands.
 *
 *  The core guarantee: the four commands are registered and route to the
 *  currently-registered OutlineNavigatorRegistry navigator, but they carry NO
 *  default keybinding. While the tree is focused Ctrl+J/K/H/L are claimed by
 *  ctrlNavigationRegistry at window capture; Ctrl+P/N stay with the global
 *  Quick Open / New File commands.
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
const ALL_ACTIONS = [
  OutlineNavigateUpAction,
  OutlineNavigateDownAction,
  OutlineNavigateLeftAction,
  OutlineNavigateRightAction,
] as const

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

  it('registers a command for each direction', () => {
    for (const A of ALL_ACTIONS) {
      disposables.push(registerAction2(A))
      expect(CommandsRegistry.getCommand(A.ID)).toBeDefined()
    }
  })

  it('declares no default keybinding', () => {
    for (const A of ALL_ACTIONS) disposables.push(registerAction2(A))
    const ids = new Set<string>(ALL_ACTIONS.map((A) => A.ID))
    expect(KeybindingsRegistry.getAllKeybindings().filter((kb) => ids.has(kb.command))).toEqual([])
  })

  it('does not resolve any old emacs alias even when the outline is focused', () => {
    for (const A of ALL_ACTIONS) disposables.push(registerAction2(A))
    const c = ctx(OUTLINE_VIEW)
    for (const key of ['ctrl+p', 'ctrl+n', 'ctrl+j', 'ctrl+b', 'ctrl+f', 'ctrl+h', 'ctrl+l']) {
      expect(KeybindingsRegistry.resolveKeybinding(key, c)).toBeUndefined()
    }
  })

  it('handlers route to the registered navigator', async () => {
    for (const A of ALL_ACTIONS) disposables.push(registerAction2(A))
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
