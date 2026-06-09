/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Git blame actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class ToggleBlameEditorDecorationAction extends Action2 {
  static readonly ID = 'git.blame.toggleEditorDecoration'

  constructor() {
    super({
      id: ToggleBlameEditorDecorationAction.ID,
      title: 'Toggle Git Blame Editor Decoration',
      category: 'Git',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const current = config.get<boolean>('git.blame.editorDecoration.enabled') ?? true
    config.update('git.blame.editorDecoration.enabled', !current, ConfigurationTarget.User)
  }
}

export class ToggleBlameStatusBarItemAction extends Action2 {
  static readonly ID = 'git.blame.toggleStatusBarItem'

  constructor() {
    super({
      id: ToggleBlameStatusBarItemAction.ID,
      title: 'Toggle Git Blame Status Bar Item',
      category: 'Git',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const current = config.get<boolean>('git.blame.statusBarItem.enabled') ?? true
    config.update('git.blame.statusBarItem.enabled', !current, ConfigurationTarget.User)
  }
}
