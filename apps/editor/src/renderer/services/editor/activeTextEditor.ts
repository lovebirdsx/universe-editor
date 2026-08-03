/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  activeTextEditor — capability-based lookup of the active group's mounted
 *  Monaco editor. Text-bearing inputs that are NOT FileEditorInput (untitled
 *  buffers, schema viewers, …) still mount through the FileEditor component and
 *  register here, so `instanceof FileEditorInput` gates would silently drop
 *  them. Anything that wants "the editor the user is typing in" should use this
 *  instead of a type check.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IEditorGroupsService } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
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
