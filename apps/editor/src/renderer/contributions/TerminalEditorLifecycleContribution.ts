/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Close the editor tab when its terminal process exits.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { TerminalEditorInput } from '../services/editor/TerminalEditorInput.js'
import { ITerminalManagerService } from '../services/terminal/TerminalManagerService.js'

export class TerminalEditorLifecycleContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @ITerminalManagerService private readonly _manager: ITerminalManagerService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
  ) {
    super()
    this._register(
      this._manager.onDidTerminalExit(({ id, target }) => {
        if (target !== 'editor') return
        for (const group of this._editorGroups.groups) {
          const editor = group.editors.find(
            (e) => e instanceof TerminalEditorInput && e.terminalId === id,
          )
          if (editor) {
            group.closeEditor(editor as TerminalEditorInput)
            return
          }
        }
      }),
    )
  }
}
