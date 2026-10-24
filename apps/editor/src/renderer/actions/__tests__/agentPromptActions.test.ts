/*---------------------------------------------------------------------------------------------
 *  Tests for the prompt image undo/redo bindings. The feature's core promise is
 *  negative: whenever no image entry is consumable, Ctrl+Z / Ctrl+Y must behave
 *  exactly as before (Monaco text undo). These tests pin that fall-through, the
 *  focus/availability conjunction, and widget routing.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  KeybindingWeight,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { RedoPromptImageAction, UndoPromptImageAction } from '../agentPromptActions.js'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
} from '../../services/acp/session/acpChatWidgetService.js'
import { makeFakeAcpChatWidget } from '../../__tests__/_helpers/fakeAcpChatWidget.js'

describe('Agent prompt image undo/redo actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function context(state: {
    undo?: boolean
    redo?: boolean
    promptFocused?: boolean
  }): ContextKeyService {
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('acpPromptInputFocused', state.promptFocused ?? true)
    ctx.createKey<boolean>('acpPromptImageUndoAvailable', state.undo ?? false)
    ctx.createKey<boolean>('acpPromptImageRedoAvailable', state.redo ?? false)
    return ctx
  }

  /** The undo/redo mirrors monacoActionsBridge registers at the Monaco weight. */
  function registerMonacoDefaults(): void {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+z',
        command: 'undo',
        weight: KeybindingWeight.MonacoDefault,
      }),
    )
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+y',
        command: 'redo',
        weight: KeybindingWeight.MonacoDefault,
      }),
    )
  }

  it('claims Ctrl+Z only while the focused prompt has an image to undo', () => {
    disposables.push(registerAction2(UndoPromptImageAction))
    registerMonacoDefaults()

    expect(KeybindingsRegistry.resolveKeybinding('ctrl+z', context({ undo: true }))).toBe(
      UndoPromptImageAction.ID,
    )

    // No consumable entry at the current text version: the binding drops out of
    // the registry so Monaco's own undo keeps the key for the text.
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+z', context({ undo: false }))).toBe('undo')

    // Outside the prompt input the chat-scoped binding must not fire either.
    expect(
      KeybindingsRegistry.resolveKeybinding(
        'ctrl+z',
        context({ undo: true, promptFocused: false }),
      ),
    ).toBe('undo')
  })

  it('claims Ctrl+Y and Ctrl+Shift+Z only while an image redo is pending', () => {
    disposables.push(registerAction2(RedoPromptImageAction))
    registerMonacoDefaults()

    const armed = context({ redo: true })
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+y', armed)).toBe(RedoPromptImageAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+z', armed)).toBe(
      RedoPromptImageAction.ID,
    )

    const idle = context({ redo: false })
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+y', idle)).toBe('redo')
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+z', idle)).toBeUndefined()
  })

  it('is not listed in the command palette (availability is transient)', () => {
    disposables.push(registerAction2(UndoPromptImageAction))
    disposables.push(registerAction2(RedoPromptImageAction))
    const ids = MenuRegistry.getMenuItems(
      MenuId.CommandPalette,
      context({ undo: true, redo: true }),
    )
      .filter((item) => 'command' in item)
      .map((item) => ('command' in item ? item.command : ''))
    expect(ids).not.toContain(UndoPromptImageAction.ID)
    expect(ids).not.toContain(RedoPromptImageAction.ID)
  })

  it('routes to the last-focused widget and tolerates no widget', () => {
    disposables.push(registerAction2(UndoPromptImageAction))
    disposables.push(registerAction2(RedoPromptImageAction))

    const undoPromptImage = vi.fn(() => true)
    const redoPromptImage = vi.fn(() => true)
    const widget = makeFakeAcpChatWidget({ undoPromptImage, redoPromptImage })

    run(UndoPromptImageAction.ID, widget)
    expect(undoPromptImage).toHaveBeenCalledTimes(1)

    run(RedoPromptImageAction.ID, widget)
    expect(redoPromptImage).toHaveBeenCalledTimes(1)

    expect(() => run(UndoPromptImageAction.ID, undefined)).not.toThrow()
  })

  function run(commandId: string, widget: AcpChatWidget | undefined): void {
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: widget,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(commandId)!.handler(accessor)
    })
  }
})
