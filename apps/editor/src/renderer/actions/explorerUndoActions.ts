/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Undo / redo for Explorer file operations. These reuse the shared
 *  IUndoRedoService but scope to EXPLORER_UNDO_SOURCE so they only walk the
 *  file-operation history (create / rename / move / copy / delete), never the
 *  text editors' undo stacks.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IUndoRedoService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { EXPLORER_UNDO_SOURCE } from '../services/explorer/ExplorerFileOperationService.js'

const EXPLORER_UNDO_WHEN =
  "focusedView == 'workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus && explorerEnableUndo"

export class UndoExplorerFileOperationAction extends Action2 {
  static readonly ID = 'filesExplorer.undo'
  constructor() {
    super({
      id: UndoExplorerFileOperationAction.ID,
      title: localize2('action.filesExplorer.undo', 'Undo'),
      category: localize2('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+z', when: EXPLORER_UNDO_WHEN },
      f1: false,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const undoRedo = accessor.get(IUndoRedoService)
    if (undoRedo.canUndo(EXPLORER_UNDO_SOURCE)) {
      await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    }
  }
}

export class RedoExplorerFileOperationAction extends Action2 {
  static readonly ID = 'filesExplorer.redo'
  constructor() {
    super({
      id: RedoExplorerFileOperationAction.ID,
      title: localize2('action.filesExplorer.redo', 'Redo'),
      category: localize2('command.category.file', 'File'),
      keybinding: [
        { primary: 'ctrl+y', when: EXPLORER_UNDO_WHEN },
        { primary: 'ctrl+shift+z', when: EXPLORER_UNDO_WHEN },
      ],
      f1: false,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const undoRedo = accessor.get(IUndoRedoService)
    if (undoRedo.canRedo(EXPLORER_UNDO_SOURCE)) {
      await undoRedo.redo(EXPLORER_UNDO_SOURCE)
    }
  }
}
