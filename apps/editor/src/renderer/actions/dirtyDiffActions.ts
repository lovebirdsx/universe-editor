/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dirty-diff navigation — "Go to Next/Previous Change" inside a regular file
 *  editor, jumping between the change regions (current document vs git HEAD)
 *  that DirtyDiffContribution paints in the gutter. Mirrors VSCode's
 *  `workbench.action.editor.{next,previous}Change` (Alt+PageDown / Alt+PageUp).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import {
  IDirtyDiffNavigationService,
  findAdjacentChange,
} from '../services/scm/DirtyDiffNavigationService.js'

const WHEN = "editorTextFocus && !isInDiffEditor && quickDiffDecorationCount != '0'"

function goToChange(accessor: ServicesAccessor, direction: 'next' | 'previous'): void {
  const group = accessor.get(IEditorGroupsService).activeGroup
  const active = group.activeEditor
  if (!(active instanceof FileEditorInput)) return
  const editor = FileEditorRegistry.get(active, group.id)
  if (!editor) return

  const line = editor.getPosition()?.lineNumber ?? 1
  const target = findAdjacentChange(
    accessor.get(IDirtyDiffNavigationService).regions,
    line,
    direction,
  )
  if (!target) return

  editor.setPosition({ lineNumber: target.startLine, column: 1 })
  editor.revealLineInCenterIfOutsideViewport(target.startLine)
  editor.focus()
}

export class GoToNextChangeAction extends Action2 {
  static readonly ID = 'workbench.action.editor.nextChange'

  constructor() {
    super({
      id: GoToNextChangeAction.ID,
      title: localize2('action.editor.nextChange.title', 'Go to Next Change'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+pagedown', when: WHEN },
      precondition: WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToChange(accessor, 'next')
  }
}

export class GoToPreviousChangeAction extends Action2 {
  static readonly ID = 'workbench.action.editor.previousChange'

  constructor() {
    super({
      id: GoToPreviousChangeAction.ID,
      title: localize2('action.editor.previousChange.title', 'Go to Previous Change'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+pageup', when: WHEN },
      precondition: WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    goToChange(accessor, 'previous')
  }
}
