/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests: verify that ctrl+k chord bindings are reachable and that
 *  direction-based focus actions resolve correctly as chords.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingsRegistry, registerAction2, type IDisposable } from '@universe-editor/platform'
import { FocusBelowGroupAction, FocusLeftGroupAction } from '../editorActions.js'
import { OpenKeybindingsEditorAction } from '../preferencesActions.js'
import { OpenFolderAction } from '../workspaceActions.js'

describe('chord priority — ctrl+k conflicts', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('ctrl+k enters chord mode when chord bindings share the first key', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    // Pressing ctrl+k must enter chord mode.
    const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(first.kind).toBe('enter-chord')
  })

  it('ctrl+k ctrl+s resolves to OpenKeybindingsEditorAction', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(first.kind).toBe('enter-chord')

    const second = KeybindingsRegistry.resolveKeystroke('ctrl+s', undefined, ['ctrl+k'])
    expect(second).toMatchObject({ kind: 'execute', command: OpenKeybindingsEditorAction.ID })
  })

  it('ctrl+k ctrl+o resolves to OpenFolderAction', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+o', undefined, ['ctrl+k'])).toMatchObject({
      kind: 'execute',
      command: OpenFolderAction.ID,
    })
  })

  it('ctrl+k ctrl+down resolves to FocusBelowGroupAction', () => {
    disposables.push(registerAction2(FocusBelowGroupAction))
    disposables.push(registerAction2(FocusLeftGroupAction))

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+down', undefined, ['ctrl+k'])).toMatchObject({
      kind: 'execute',
      command: FocusBelowGroupAction.ID,
    })
  })

  it('mismatched second stroke yields no-match (does not fall back to single-stroke)', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))

    // ctrl+k enters chord mode
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    // Second stroke that matches no chord → no-match
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+z', undefined, ['ctrl+k']).kind).toBe(
      'no-match',
    )
  })
})
