/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Alternative default keys for editor-core commands whose native key this
 *  editor has taken for a different feature. Nothing here mirrors monaco — the
 *  core command has no *primary* of its own on the keys below — so every entry
 *  is a product decision with two halves:
 *
 *  - the native key keeps doing what this editor made it do (the "keys the
 *    workbench claims" table in docs/user/zh-CN/reference/editor-shortcuts.md).
 *    For the two scroll entries that takeover is conditional: the workbench only
 *    claims Alt+PageUp/PageDown while the file has changes, so there the
 *    alternative is about a key that is stable either way, not a dead one.
 *  - the alternative gives the core command a key monaco holds no primary on.
 *
 *  A monaco *secondary* on the same key is shadowed all the same, and that is
 *  unavoidable for a binding that must preventDefault: Ctrl+Shift+↑/↓ is
 *  cursorUpSelect's secondary on Windows and insertCursorAbove's on Linux, so
 *  both lose to move-line here. Their primary keys (Shift+↑/↓, Shift+Alt+↑/↓)
 *  are untouched, and the user doc says so.
 *
 *  Weight must stay above KeybindingWeight.MonacoDefault: the dispatcher defers
 *  (returns without preventDefault) at that weight, so a deferred binding on a
 *  key monaco has never heard of would be dead.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  KeybindingsRegistry,
  KeybindingWeight,
  combinedDisposable,
  type IDisposable,
} from '@universe-editor/platform'

export interface IMonacoCompatKeybinding {
  readonly id: string
  readonly key: string
  readonly when: string
  /**
   * The core command's own default key. Out of reach while `takenBy`'s
   * when-clause holds — which for the scroll entries is only while the file has
   * changes.
   */
  readonly nativeKey: string
  /** The binding that outranks `nativeKey` whenever its when-clause holds. */
  readonly takenBy: string
}

const EDITOR = 'editorTextFocus && !isInMergeEditor'

/**
 * The merge editor's result pane sets `editorTextFocus` but mounts outside
 * FileEditorRegistry, so the mirrored handler cannot reach an editor there and
 * would only pop "requires an active text editor" — `!isInMergeEditor` keeps
 * these keys silent instead.
 */
export const MONACO_COMPAT_KEYBINDINGS: readonly IMonacoCompatKeybinding[] = [
  {
    id: 'editor.action.moveLinesUpAction',
    key: 'ctrl+shift+up',
    when: EDITOR,
    nativeKey: 'alt+up',
    takenBy: 'findWordAtCursor.previous',
  },
  {
    id: 'editor.action.moveLinesDownAction',
    key: 'ctrl+shift+down',
    when: EDITOR,
    nativeKey: 'alt+down',
    takenBy: 'findWordAtCursor.next',
  },
  {
    id: 'editor.action.copyLinesDownAction',
    key: 'ctrl+shift+d',
    when: `${EDITOR} && isLinux`,
    nativeKey: 'ctrl+alt+shift+down',
    takenBy: 'workbench.action.increaseViewHeight',
  },
  {
    id: 'editor.action.copyLinesUpAction',
    key: 'ctrl+shift+alt+d',
    when: `${EDITOR} && isLinux`,
    nativeKey: 'ctrl+alt+shift+up',
    takenBy: 'workbench.action.decreaseViewHeight',
  },
  {
    id: 'editor.toggleFold',
    key: 'ctrl+shift+alt+f',
    when: EDITOR,
    nativeKey: 'ctrl+k ctrl+l',
    takenBy: 'workbench.action.agent.addSelectionToExistingChat',
  },
  {
    id: 'scrollPageUp',
    key: 'shift+alt+pageup',
    when: EDITOR,
    nativeKey: 'alt+pageup',
    takenBy: 'workbench.action.editor.previousChange',
  },
  {
    id: 'scrollPageDown',
    key: 'shift+alt+pagedown',
    when: EDITOR,
    nativeKey: 'alt+pagedown',
    takenBy: 'workbench.action.editor.nextChange',
  },
  {
    id: 'editor.action.formatDocument',
    key: 'shift+alt+f',
    when: `${EDITOR} && isLinux`,
    nativeKey: 'ctrl+shift+i',
    takenBy: 'workbench.action.toggleDevTools',
  },
]

export function registerMonacoCompatKeybindings(
  bindings: readonly IMonacoCompatKeybinding[] = MONACO_COMPAT_KEYBINDINGS,
): IDisposable {
  const disposables: IDisposable[] = []
  for (const binding of bindings) {
    // The commands come from the monaco bridge. An id typo must degrade to "key
    // stays unbound", never to a binding that swallows the keystroke with
    // nothing to run — the e2e guard asserts every id resolves.
    if (!CommandsRegistry.getCommand(binding.id)) continue
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: binding.key,
        command: binding.id,
        when: binding.when,
        weight: KeybindingWeight.WorkbenchContrib,
      }),
    )
  }
  return combinedDisposable(...disposables)
}
