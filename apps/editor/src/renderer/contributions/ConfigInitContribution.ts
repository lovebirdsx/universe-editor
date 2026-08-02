/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigInitContribution — kicks off the file-backed configuration/keybinding
 *  loads that used to run inline in bootstrap.
 *
 *  Both are registerSingleton services resolved via DI; this contribution only
 *  drives their initialize(). Both initialize() calls are fire-and-forget —
 *  subscribers refresh via their own change events once hydration completes.
 *  One-shot consumers that cannot refresh (e.g. a cold-launch deep link) must
 *  await IUserSettingsSyncService.whenInitialized instead.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { IUserSettingsSyncService } from '../services/configuration/UserSettingsSync.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'

export class ConfigInitContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IUserSettingsSyncService userSettingsSync: IUserSettingsSyncService,
    @IUserKeybindingsService userKeybindings: IUserKeybindingsService,
  ) {
    super()
    void userSettingsSync.initialize()
    // UserKeybindingsService captures its default-keybinding snapshot in the
    // constructor, which happens when DI materializes it for this injection —
    // by BlockStartup every action's keybinding is already registered (actions
    // register at module load via contributions/index.js).
    void userKeybindings.initialize()
  }
}
