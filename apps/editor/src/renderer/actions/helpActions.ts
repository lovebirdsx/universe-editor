/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help-menu Action2 commands: open the built-in guide documents.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'

export class OpenEditorGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openEditorGuide'
  constructor() {
    super({
      id: OpenEditorGuideAction.ID,
      title: localize('action.openEditorGuide.title', 'Editor Guide'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('editor-guide'))
  }
}

export class OpenAgentGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openAgentGuide'
  constructor() {
    super({
      id: OpenAgentGuideAction.ID,
      title: localize('action.openAgentGuide.title', 'Agent Guide'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 2 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('agent-guide'))
  }
}
