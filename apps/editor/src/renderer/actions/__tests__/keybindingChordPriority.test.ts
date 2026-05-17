/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests: verify that chord bindings (ctrl+k ctrl+s, ctrl+k ctrl+o) remain
 *  reachable even when SplitEditorDownAction occupies the same first key (ctrl+k)
 *  as a single-stroke binding.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingsRegistry, registerAction2, type IDisposable } from '@universe-editor/platform'
import { SplitEditorDownAction } from '../editorActions.js'
import { OpenKeybindingsEditorAction } from '../preferencesActions.js'
import { OpenFolderAction } from '../workspaceActions.js'

describe('chord priority — ctrl+k conflicts', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('ctrl+k enters chord mode when chord bindings share the first key', () => {
    // Register all three: SplitEditorDown (single ctrl+k) + two chord commands.
    disposables.push(registerAction2(SplitEditorDownAction))
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    // Pressing ctrl+k must enter chord mode, not execute SplitEditorDown.
    const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(first.kind).toBe('enter-chord')
  })

  it('ctrl+k ctrl+s resolves to OpenKeybindingsEditorAction', () => {
    disposables.push(registerAction2(SplitEditorDownAction))
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(first.kind).toBe('enter-chord')

    const second = KeybindingsRegistry.resolveKeystroke('ctrl+s', undefined, ['ctrl+k'])
    expect(second).toEqual({ kind: 'execute', command: OpenKeybindingsEditorAction.ID })
  })

  it('ctrl+k ctrl+o resolves to OpenFolderAction', () => {
    disposables.push(registerAction2(SplitEditorDownAction))
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+o', undefined, ['ctrl+k'])).toEqual({
      kind: 'execute',
      command: OpenFolderAction.ID,
    })
  })

  it('SplitEditorDown is reachable via ctrl+k after chord actions are disposed', () => {
    disposables.push(registerAction2(SplitEditorDownAction))
    const d1 = registerAction2(OpenKeybindingsEditorAction)
    const d2 = registerAction2(OpenFolderAction)

    // Chords present → chord mode.
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')

    // Remove chords → single-stroke is reachable again.
    d1.dispose()
    d2.dispose()
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k')).toEqual({
      kind: 'execute',
      command: SplitEditorDownAction.ID,
    })
  })

  it('mismatched second stroke yields no-match (does not fall back to single-stroke)', () => {
    disposables.push(registerAction2(SplitEditorDownAction))
    disposables.push(registerAction2(OpenKeybindingsEditorAction))

    // ctrl+k enters chord mode
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    // Second stroke that matches no chord → no-match (not a fallback to SplitEditorDown)
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+z', undefined, ['ctrl+k']).kind).toBe(
      'no-match',
    )
  })
})
