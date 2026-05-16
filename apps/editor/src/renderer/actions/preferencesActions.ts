/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Preferences-related Action2 commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  MenuId,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { SettingsEditorInput } from '../workbench/preferences/SettingsEditorInput.js'

export class OpenSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.openSettings'
  constructor() {
    super({
      id: OpenSettingsAction.ID,
      title: 'Open Settings',
      category: 'Preferences',
      keybinding: [{ primary: 'ctrl+,' }, { primary: ['ctrl+k', 'ctrl+s'] }],
      menu: { id: MenuId.MenubarFileMenu, group: '5_preferences', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)

    // De-dupe: if Settings is already open in any group, reactivate it instead
    // of opening a second copy.
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof SettingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }

    groups.activeGroup.openEditor(new SettingsEditorInput())
  }
}
