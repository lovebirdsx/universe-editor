/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard undo/redo for images attached to the agent prompt.
 *
 *  Images are React state, not text, so Monaco's undo cannot reach them. These
 *  bindings claim Ctrl+Z / Ctrl+Y only while the focused prompt reports an
 *  image-history entry it can consume at the current text version (the keys are
 *  owned by IAcpChatWidgetService and aggregated per focused widget). When no
 *  entry is available the `when` clause fails, the binding disappears from the
 *  registry, and Monaco's default undo/redo keeps the keys for text — so plain
 *  text editing is unaffected.
 *--------------------------------------------------------------------------------------------*/

import { Action2, localize2, type ServicesAccessor } from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { ACP_SCOPED_KEY_WEIGHT, CATEGORY } from './_agentShared.js'

const UNDO_IMAGE_WHEN = 'acpPromptInputFocused && acpPromptImageUndoAvailable'
const REDO_IMAGE_WHEN = 'acpPromptInputFocused && acpPromptImageRedoAvailable'

export class UndoPromptImageAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.undoImage'
  constructor() {
    super({
      id: UndoPromptImageAction.ID,
      title: localize2('action.agent.prompt.undoImage', 'Undo Attached Image'),
      category: CATEGORY,
      keybinding: [{ primary: 'ctrl+z', when: UNDO_IMAGE_WHEN, weight: ACP_SCOPED_KEY_WEIGHT }],
      f1: false,
    })
  }
  override run(accessor: ServicesAccessor): void {
    // Re-check inside the command: the context key is updated from React state,
    // which can lag one render behind a very fast edit.
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.undoPromptImage()
  }
}

export class RedoPromptImageAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.redoImage'
  constructor() {
    super({
      id: RedoPromptImageAction.ID,
      title: localize2('action.agent.prompt.redoImage', 'Redo Attached Image'),
      category: CATEGORY,
      keybinding: [
        { primary: 'ctrl+y', when: REDO_IMAGE_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
        { primary: 'ctrl+shift+z', when: REDO_IMAGE_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
      ],
      f1: false,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.redoPromptImage()
  }
}
