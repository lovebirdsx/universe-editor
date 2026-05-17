/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoCommandSource — bridge the Monaco standalone editor's internal action
 *  registry into our project-wide IQuickPickItem stream so the unified command
 *  palette can offer items like "Format Document" or "Go to Line" without
 *  pre-registering them into CommandsRegistry. Monaco actions are bound to a
 *  specific editor instance, so we resolve them lazily at palette open time.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroupsService, IQuickPickItem } from '@universe-editor/platform'
import type { monaco } from '../editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'

export interface MonacoCommandItem extends IQuickPickItem {
  readonly _monaco: true
  readonly _editor: monaco.editor.IStandaloneCodeEditor
  readonly _actionId: string
}

export function isMonacoCommandItem(item: IQuickPickItem): item is MonacoCommandItem {
  return (item as Partial<MonacoCommandItem>)._monaco === true
}

export function collectMonacoCommands(groupsService: IEditorGroupsService): MonacoCommandItem[] {
  const active = groupsService.activeGroup.activeEditor
  if (!(active instanceof FileEditorInput)) return []
  const editor = FileEditorRegistry.get(active)
  if (!editor) return []
  return editor
    .getSupportedActions()
    .filter((action) => action.isSupported())
    .map((action) => ({
      id: action.id,
      label: action.label || action.id,
      description: 'Monaco',
      _monaco: true,
      _editor: editor,
      _actionId: action.id,
    }))
}
