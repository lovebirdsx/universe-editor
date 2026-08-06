/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Action2 definitions for findWordAtCursor (Alt+Down / Alt+Up word jumps).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  INotificationService,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { getActiveTextEditor } from '../services/editor/activeTextEditor.js'
import {
  collectMatches,
  computeNeedle,
  findWordHighlightController,
  pickTarget,
} from '../services/editor/findWordAtCursor.js'

const WHEN = 'editorTextFocus && !findWidgetVisible'

function runFindWordAtCursor(accessor: ServicesAccessor, direction: 1 | -1): void {
  const groups = accessor.get(IEditorGroupsService)
  const active = getActiveTextEditor(groups)
  const model = active?.editor.getModel()
  const selection = active?.editor.getSelection()
  if (!active || !model || !selection) return
  const needle = computeNeedle(model, selection)
  if (!needle) return
  findWordHighlightController.clear(active.editor)
  const target = pickTarget(collectMatches(model, needle), needle, direction)
  if (!target) {
    accessor.get(INotificationService).notify({
      severity: Severity.Info,
      message: localize('findWordAtCursor.noMoreMatches', 'No more matches.'),
    })
    return
  }
  if (needle.mode === 'strict') {
    const position = {
      lineNumber: target.range.startLineNumber,
      column: target.range.startColumn + needle.cursorDelta,
    }
    active.editor.setPosition(position)
    active.editor.revealPositionInCenterIfOutsideViewport(position)
  } else {
    active.editor.setSelection(target.range)
    active.editor.revealRangeInCenterIfOutsideViewport(target.range)
    findWordHighlightController.show(active.editor, target.range)
    findWordHighlightController.armClearOnSelectionChange(active.editor)
  }
}

export class FindWordAtCursorNextAction extends Action2 {
  static readonly ID = 'findWordAtCursor.next'
  constructor() {
    super({
      id: FindWordAtCursorNextAction.ID,
      title: localize2('action.findWordAtCursor.next.title', 'Find Word at Cursor: Next'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+down', when: WHEN },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runFindWordAtCursor(accessor, 1)
  }
}

export class FindWordAtCursorPreviousAction extends Action2 {
  static readonly ID = 'findWordAtCursor.previous'
  constructor() {
    super({
      id: FindWordAtCursorPreviousAction.ID,
      title: localize2('action.findWordAtCursor.previous.title', 'Find Word at Cursor: Previous'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'alt+up', when: WHEN },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    runFindWordAtCursor(accessor, -1)
  }
}
