/*---------------------------------------------------------------------------------------------
 *  Regression: F2 in a focused text editor must trigger Monaco's symbol rename
 *  (`editor.action.rename`), not the Explorer file rename
 *  (`workbench.files.action.rename`).
 *
 *  The Explorer rename binding used to register F2 with no `when` clause at the
 *  default `WorkbenchContrib` weight, which outranks Monaco's `editor.action.rename`
 *  default (mirrored at `MonacoDefault` weight, gated on `editorFocus`). So
 *  resolving F2 always picked the Explorer rename even with the cursor on a
 *  symbol in a code editor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  KeybindingsRegistry,
  KeybindingWeight,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { RenameFileAction } from '../fileMutateActions.js'

describe('F2 rename keybinding arbitration', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function setup() {
    // Explorer file-rename Action2 (the binding under test).
    disposables.push(registerAction2(RenameFileAction))
    // Monaco's built-in symbol rename, as monacoActionsBridge mirrors it:
    // MonacoDefault weight, gated on `editorFocus`.
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'f2',
        command: 'editor.action.rename',
        when: 'editorFocus',
        weight: KeybindingWeight.MonacoDefault,
      }),
    )
    return new ContextKeyService()
  }

  it('resolves to Monaco symbol rename when a text editor is focused', () => {
    const ctx = setup()
    // Cursor is in a code editor: Monaco holds focus, the Explorer tree does not.
    ctx.set('editorFocus', true)
    ctx.set('editorTextFocus', true)
    ctx.set('focusedView', '')

    const result = KeybindingsRegistry.resolveKeystroke('f2', ctx, undefined)
    expect(result.kind).toBe('execute')
    if (result.kind !== 'execute') return
    expect(result.command).toBe('editor.action.rename')
  })

  it('resolves to Explorer file rename when the Explorer tree is focused', () => {
    const ctx = setup()
    ctx.set('editorFocus', false)
    ctx.set('editorTextFocus', false)
    ctx.set('focusedView', 'workbench.view.explorer.tree')

    const result = KeybindingsRegistry.resolveKeystroke('f2', ctx, undefined)
    expect(result.kind).toBe('execute')
    if (result.kind !== 'execute') return
    expect(result.command).toBe(RenameFileAction.ID)
  })
})
