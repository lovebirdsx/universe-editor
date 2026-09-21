/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Default keys this editor adds for editor-core commands monaco ships with no
 *  key at all. The sort actions are the case: their EditorAction descriptors
 *  carry no `_kbOpts`, so the mirror installs no default and the commands stay
 *  palette-only until a key is given here. Unlike the compat table these are not
 *  restorations — F9 / Shift+F9 are unbound in the workbench and in monaco.
 *
 *  `!editorReadonly` is on top of the shared editor scope because both actions are
 *  gated on monaco's `writable` precondition: in a read-only editor the command
 *  can only no-op, so the key should not claim the keystroke either.
 *--------------------------------------------------------------------------------------------*/

import { EDITOR_TEXT_FOCUS, type IMonacoCommandKeybinding } from './monacoCommandKeybindings.js'

const WHEN = `${EDITOR_TEXT_FOCUS} && !editorReadonly`

export const MONACO_EXTRA_KEYBINDINGS: readonly IMonacoCommandKeybinding[] = [
  { id: 'editor.action.sortLinesAscending', key: 'f9', when: WHEN },
  { id: 'editor.action.sortLinesDescending', key: 'shift+f9', when: WHEN },
]
