/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registration for the key tables this editor layers on top of the monaco
 *  mirror — the compat table (alternative for an editor-core command whose
 *  native key the workbench took) and the extra table (a default key for a core
 *  command monaco ships keyless). Two tables, one mechanism, one place to read
 *  the two rules that are easy to get wrong:
 *
 *  - Weight must stay above KeybindingWeight.MonacoDefault: the dispatcher defers
 *    (returns without preventDefault) at that weight, and monaco holds no binding
 *    on a key from these tables, so a deferred binding would be dead.
 *  - An id that never got a command is skipped rather than bound: the keystroke
 *    would otherwise be swallowed with nothing to run.
 *
 *  Both tables are registered only after the mirror has registered its commands.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  KeybindingsRegistry,
  KeybindingWeight,
  combinedDisposable,
  type IDisposable,
} from '@universe-editor/platform'

/**
 * The merge editor's result pane sets `editorTextFocus` but mounts outside
 * FileEditorRegistry, so the mirrored handler cannot reach an editor there and
 * would only pop "requires an active text editor" — `!isInMergeEditor` keeps
 * these keys silent instead.
 */
export const EDITOR_TEXT_FOCUS = 'editorTextFocus && !isInMergeEditor'

export interface IMonacoCommandKeybinding {
  readonly id: string
  readonly key: string
  readonly when: string
}

export function registerMonacoCommandKeybindings(
  bindings: readonly IMonacoCommandKeybinding[],
): IDisposable {
  const disposables: IDisposable[] = []
  for (const binding of bindings) {
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
