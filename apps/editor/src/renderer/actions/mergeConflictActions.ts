/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Merge-conflict navigation — jump the cursor between git conflict regions in
 *  the active file editor. Mirrors VSCode's merge-conflict.next / .previous.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { parseConflicts } from '../workbench/scm/mergeConflict/conflictParser.js'

function goToConflict(accessor: ServicesAccessor, target: 'next' | 'previous'): void {
  const group = accessor.get(IEditorGroupsService).activeGroup
  const active = group.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active, group.id)
  const model = editor?.getModel()
  if (!editor || !model) return

  const conflicts = parseConflicts(model.getValue())
  if (conflicts.length === 0) return

  const line = editor.getPosition()?.lineNumber ?? 1
  const next =
    target === 'next'
      ? (conflicts.find((c) => c.startLine > line) ?? conflicts[0]!)
      : ([...conflicts].reverse().find((c) => c.startLine < line) ??
        conflicts[conflicts.length - 1]!)

  editor.setPosition({ lineNumber: next.startLine, column: 1 })
  editor.revealLineInCenter(next.startLine)
  editor.focus()
}

export class GoToNextMergeConflictAction extends Action2 {
  static readonly ID = 'merge-conflict.next'

  constructor() {
    super({
      id: GoToNextMergeConflictAction.ID,
      title: localize('mergeConflict.next.title', 'Go to Next Merge Conflict'),
      category: localize('command.category.mergeConflict', 'Merge Conflict'),
      keybinding: { primary: 'alt+f9', when: 'editorTextFocus' },
      precondition: 'editorTextFocus',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToConflict(accessor, 'next')
  }
}

export class GoToPreviousMergeConflictAction extends Action2 {
  static readonly ID = 'merge-conflict.previous'

  constructor() {
    super({
      id: GoToPreviousMergeConflictAction.ID,
      title: localize('mergeConflict.previous.title', 'Go to Previous Merge Conflict'),
      category: localize('command.category.mergeConflict', 'Merge Conflict'),
      keybinding: { primary: 'shift+alt+f9', when: 'editorTextFocus' },
      precondition: 'editorTextFocus',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToConflict(accessor, 'previous')
  }
}
