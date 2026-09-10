/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  activeTextEditor — capability-based lookup of a mounted Monaco editor.
 *
 *  Two queries live here:
 *   - `getActiveTextEditor`: the *active group's* mounted editor. Text-bearing
 *     inputs that are NOT FileEditorInput (untitled buffers, schema viewers, …)
 *     still mount through the FileEditor component and register here, so
 *     `instanceof FileEditorInput` gates would silently drop them. Anything that
 *     wants "the editor the user is typing in" should use this instead of a type
 *     check. It deliberately does NOT cover editors living outside a group (the
 *     Output panel's log editor, peek previews, diff sides, the ACP prompt).
 *   - `getFocusedMonacoEditor`: whichever registered Monaco editor holds DOM
 *     focus, group or not — the workbench counterpart of Monaco's own
 *     `getFocusedCodeEditor()`. Command targets that must follow the user's
 *     focus (the Find family) resolve through it.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IEditorGroupsService } from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'

export interface IActiveTextEditor {
  readonly input: EditorInput
  readonly editor: monaco.editor.IStandaloneCodeEditor
}

export function getActiveTextEditor(groups: IEditorGroupsService): IActiveTextEditor | undefined {
  const group = groups.activeGroup
  const input = group.activeEditor
  if (!input) return undefined
  // The same input can be mounted in a split in another group; prefer this
  // group's instance, fall back to whichever registration is live.
  const editor = FileEditorRegistry.get(input, group.id) ?? FileEditorRegistry.get(input)
  if (!editor) return undefined
  return { input, editor }
}

/**
 * The Monaco editor that currently holds DOM focus, wherever it lives (editor
 * group, Output panel, diff side, peek preview, ACP prompt). Mirrors VSCode's
 * `ICodeEditorService.getFocusedCodeEditor()`.
 *
 * `hasWidgetFocus()` is false once the model is detached (`setModel(null)`), so
 * an editor with no content never claims the focus — the Output panel relies on
 * that to stay inert while it shows "No output.".
 */
export function getFocusedMonacoEditor(): monaco.editor.ICodeEditor | undefined {
  const m = MonacoLoader.peek()
  if (!m) return undefined
  return m.editor.getEditors().find((editor) => editor.hasWidgetFocus())
}
