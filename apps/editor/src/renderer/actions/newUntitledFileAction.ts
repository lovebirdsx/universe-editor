/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  NewUntitledFileAction — Ctrl+N opens a new in-memory `Untitled-N` buffer.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IInstantiationService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { UntitledEditorInput } from '../workbench/editor/UntitledEditorInput.js'

export class NewUntitledFileAction extends Action2 {
  static readonly ID = 'workbench.action.files.newUntitledFile'
  constructor() {
    super({
      id: NewUntitledFileAction.ID,
      title: localize('action.newUntitledFile.title', 'New File'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+n' },
      menu: { id: MenuId.MenubarFileMenu, group: '1_new', order: 0 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const inst = accessor.get(IInstantiationService)
    const groups = accessor.get(IEditorGroupsService)
    const input = inst.createInstance(UntitledEditorInput)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}
