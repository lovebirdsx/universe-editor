/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class ToggleVimModeAction extends Action2 {
  static readonly ID = 'workbench.action.toggleVimMode'
  constructor() {
    super({
      id: ToggleVimModeAction.ID,
      title: localize2('action.toggleVimMode.title', 'Toggle Vim Mode'),
      category: localize2('command.category.editor', 'Editor'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const enabled = config.get<boolean>('editor.vimMode.enabled') === true
    config.update('editor.vimMode.enabled', !enabled, ConfigurationTarget.User)
  }
}
