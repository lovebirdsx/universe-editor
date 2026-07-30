/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Blame display toggles (provider-neutral — they flip the scm.blame.* settings
 *  that ScmBlameContribution reads).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class ToggleBlameEditorDecorationAction extends Action2 {
  static readonly ID = 'scm.blame.toggleEditorDecoration'

  constructor() {
    super({
      id: ToggleBlameEditorDecorationAction.ID,
      title: localize2(
        'action.scm.blame.toggleEditorDecoration.title',
        'Toggle Blame Editor Decoration',
      ),
      category: localize2('command.category.scm', 'Source Control'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const current = config.get<boolean>('scm.blame.editorDecoration.enabled') ?? true
    config.update('scm.blame.editorDecoration.enabled', !current, ConfigurationTarget.User)
  }
}

export class ToggleBlameStatusBarItemAction extends Action2 {
  static readonly ID = 'scm.blame.toggleStatusBarItem'

  constructor() {
    super({
      id: ToggleBlameStatusBarItemAction.ID,
      title: localize2(
        'action.scm.blame.toggleStatusBarItem.title',
        'Toggle Blame Status Bar Item',
      ),
      category: localize2('command.category.scm', 'Source Control'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const current = config.get<boolean>('scm.blame.statusBarItem.enabled') ?? true
    config.update('scm.blame.statusBarItem.enabled', !current, ConfigurationTarget.User)
  }
}
