/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Populates the menubar Edit menu. The undo/redo/clipboard/select-all commands
 *  are Monaco-backed (mirrored into CommandsRegistry by monacoActionsBridge);
 *  find/replace reuse the already-registered search Action2's. Items stay
 *  visible regardless of editor focus — clicking is a no-op when no editor is
 *  active.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  MenuId,
  MenuRegistry,
  localize,
} from '@universe-editor/platform'
import { FindInFileAction, FindReplaceInFileAction } from '../actions/searchActions.js'

export class EditMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    const add = (command: string, title: string, group: string, order: number): void => {
      this._register(
        MenuRegistry.addMenuItem(MenuId.MenubarEditMenu, { command, title, group, order }),
      )
    }

    add('undo', localize('action.undo.title', 'Undo'), '1_undo', 1)
    add('redo', localize('action.redo.title', 'Redo'), '1_undo', 2)

    add('editor.action.clipboardCutAction', localize('action.cut.title', 'Cut'), '2_ccp', 1)
    add('editor.action.clipboardCopyAction', localize('action.copy.title', 'Copy'), '2_ccp', 2)
    add('editor.action.clipboardPasteAction', localize('action.paste.title', 'Paste'), '2_ccp', 3)

    add(
      'editor.action.selectAll',
      localize('action.selectAll.title', 'Select All'),
      '3_selectAll',
      1,
    )

    add(FindInFileAction.ID, localize('action.find.title', 'Find'), '4_find', 1)
    add(FindReplaceInFileAction.ID, localize('action.replace.title', 'Replace'), '4_find', 2)
  }
}
