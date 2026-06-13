/*---------------------------------------------------------------------------------------------
 *  Tests for monacoActionsBridge — feed a fake EditorExtensionsRegistry, verify
 *  the bridge populates CommandsRegistry + the default-keybinding side-table,
 *  and that dispose() reverses both sides cleanly.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  KeybindingsRegistry,
  KeybindingWeight,
  type IDisposable,
} from '@universe-editor/platform'
import {
  bridgeMonacoActionsForTests,
  getAllMonacoDefaultKeybindings,
  getMonacoDefaultKeybinding,
  type CoreCommand,
  type IMonacoEditorExtensionsRegistry,
} from '../monaco/monacoActionsBridge.js'

const CtrlCmd = 2048
const Shift = 1024
const Alt = 512
const KC_KeyF = 36
const KC_KeyZ = 56
const KC_KeyY = 55
const KC_KeyA = 31
const KC_F1 = 59

type NlsGlobals = { __MONACO_NLS__?: Record<string, string> }

function makeRegistry(
  actions: { id: string; label: string; _kbOpts?: unknown }[],
): IMonacoEditorExtensionsRegistry {
  return { getEditorActions: () => actions as never }
}

describe('bridgeMonacoActionsForTests', () => {
  let registered: IDisposable | undefined

  beforeEach(() => {
    delete (globalThis as NlsGlobals).__MONACO_NLS__
  })

  afterEach(() => {
    registered?.dispose()
    registered = undefined
    delete (globalThis as NlsGlobals).__MONACO_NLS__
  })

  it('registers each EditorAction into CommandsRegistry with label/category', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        { id: 'editor.action.formatDocument', label: 'Format Document', _kbOpts: undefined },
        { id: 'editor.action.commentLine', label: 'Toggle Line Comment' },
      ]),
      [],
    )

    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('editor.action.formatDocument')?.metadata).toEqual({
      description: 'Format Document',
      category: 'Editor',
    })
    expect(cmds.get('editor.action.commentLine')?.metadata).toEqual({
      description: 'Toggle Line Comment',
      category: 'Editor',
    })
  })

  it('records the first decoded default keybinding for each action', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [],
    )
    expect(getMonacoDefaultKeybinding('editor.action.formatDocument')).toEqual({
      key: 'alt+shift+f',
    })
  })

  it('handles kbOpts as an array — takes the first non-zero primary', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.foo',
          label: 'Foo',
          _kbOpts: [{ primary: 0 }, { primary: KC_F1 }, { primary: CtrlCmd | KC_KeyA }],
        },
      ]),
      [],
    )
    expect(getMonacoDefaultKeybinding('editor.action.foo')).toEqual({ key: 'f1' })
  })

  it('skips the default-keybinding map entry when the key code is unsupported', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.bar',
          label: 'Bar',
          _kbOpts: { primary: CtrlCmd | 124 }, // 124 = MediaTrackNext, unsupported
        },
      ]),
      [],
    )
    // Command still registered for visibility in the shortcuts editor.
    expect(CommandsRegistry.getCommands().get('editor.action.bar')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.bar')).toBeUndefined()
  })

  it('registers actions without kbOpts (command-only, no default key)', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([{ id: 'editor.action.noKb', label: 'No KB' }]),
      [],
    )
    expect(CommandsRegistry.getCommands().get('editor.action.noKb')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.noKb')).toBeUndefined()
  })

  it('registers core commands (undo/redo/selectAll) with NLS labels and defaults', () => {
    ;(globalThis as NlsGlobals).__MONACO_NLS__ = {
      undo: '撤销',
      redo: '重做',
      'selectAll.label': '全选',
    }
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
      { id: 'redo', label: 'Redo', nlsKey: 'redo', primary: CtrlCmd | KC_KeyY },
      {
        id: 'editor.action.selectAll',
        label: 'Select All',
        nlsKey: 'selectAll.label',
        primary: CtrlCmd | KC_KeyA,
      },
    ]
    registered = bridgeMonacoActionsForTests(makeRegistry([]), coreCommands)

    const cmds = CommandsRegistry.getCommands()
    expect(cmds.get('undo')?.metadata?.description).toBe('撤销')
    expect(cmds.get('redo')?.metadata?.description).toBe('重做')
    expect(cmds.get('editor.action.selectAll')?.metadata?.description).toBe('全选')
    expect(getMonacoDefaultKeybinding('undo')).toEqual({ key: 'ctrl+z' })
    expect(getMonacoDefaultKeybinding('redo')).toEqual({ key: 'ctrl+y' })
    expect(getMonacoDefaultKeybinding('editor.action.selectAll')).toEqual({ key: 'ctrl+a' })
  })

  it('falls back to English when NLS table is missing the key', () => {
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
    ]
    registered = bridgeMonacoActionsForTests(makeRegistry([]), coreCommands)
    expect(CommandsRegistry.getCommands().get('undo')?.metadata?.description).toBe('Undo')
  })

  it('deduplicates: an EditorAction id wins over a core command of the same id', () => {
    const coreCommands: CoreCommand[] = [
      { id: 'undo', label: 'Core Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
    ]
    registered = bridgeMonacoActionsForTests(
      makeRegistry([{ id: 'undo', label: 'Action Undo', _kbOpts: { primary: CtrlCmd | KC_KeyZ } }]),
      coreCommands,
    )
    expect(CommandsRegistry.getCommands().get('undo')?.metadata?.description).toBe('Action Undo')
    expect(getMonacoDefaultKeybinding('undo')).toEqual({ key: 'ctrl+z' })
  })

  it('exposes all defaults via getAllMonacoDefaultKeybindings()', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [{ id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ }],
    )
    const all = getAllMonacoDefaultKeybindings()
    expect(all.size).toBe(2)
    expect(all.get('editor.action.formatDocument')).toEqual({ key: 'alt+shift+f' })
    expect(all.get('undo')).toEqual({ key: 'ctrl+z' })
  })

  it('dispose() removes both the command and the default-keybinding entry', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.demo',
          label: 'Demo',
          _kbOpts: { primary: CtrlCmd | KC_KeyA },
        },
      ]),
      [{ id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ }],
    )
    expect(CommandsRegistry.getCommands().get('editor.action.demo')).toBeDefined()
    expect(getMonacoDefaultKeybinding('editor.action.demo')).toBeDefined()
    expect(getMonacoDefaultKeybinding('undo')).toBeDefined()

    registered.dispose()
    registered = undefined
    expect(CommandsRegistry.getCommands().get('editor.action.demo')).toBeUndefined()
    expect(CommandsRegistry.getCommands().get('undo')).toBeUndefined()
    expect(getMonacoDefaultKeybinding('editor.action.demo')).toBeUndefined()
    expect(getMonacoDefaultKeybinding('undo')).toBeUndefined()
  })

  it('registers the default key into KeybindingsRegistry at MonacoDefault weight, gated on editorFocus', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.formatDocument',
          label: 'Format Document',
          _kbOpts: { primary: Shift | Alt | KC_KeyF },
        },
      ]),
      [],
    )
    const bound = KeybindingsRegistry.getAllKeybindings().filter(
      (kb) => kb.command === 'editor.action.formatDocument',
    )
    expect(bound).toHaveLength(1)
    expect(bound[0]!.key).toBe('alt+shift+f')
    expect(bound[0]!.weight).toBe(KeybindingWeight.MonacoDefault)
    const when = bound[0]!.when
    expect(typeof when === 'string' ? when : when?.serialize()).toBe('editorFocus')
  })

  it('registers ALL distinct primaries from a kbOpts array, not just the first', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        {
          id: 'editor.action.multi',
          label: 'Multi',
          _kbOpts: [{ primary: KC_F1 }, { primary: CtrlCmd | KC_KeyA }],
        },
      ]),
      [],
    )
    const keys = KeybindingsRegistry.getAllKeybindings()
      .filter((kb) => kb.command === 'editor.action.multi')
      .map((kb) => kb.key)
      .sort()
    expect(keys).toEqual(['ctrl+a', 'f1'])
  })

  it('dispose() removes the registry bindings too', () => {
    registered = bridgeMonacoActionsForTests(
      makeRegistry([
        { id: 'editor.action.demo', label: 'Demo', _kbOpts: { primary: CtrlCmd | KC_KeyA } },
      ]),
      [],
    )
    expect(
      KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === 'editor.action.demo'),
    ).toBe(true)
    registered.dispose()
    registered = undefined
    expect(
      KeybindingsRegistry.getAllKeybindings().some((kb) => kb.command === 'editor.action.demo'),
    ).toBe(false)
  })
})
