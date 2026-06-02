/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigInitContribution — kicks off the file-backed configuration/keybinding
 *  loads that used to run inline in bootstrap.
 *
 *  UserSettingsSync has no service identifier (it is a pure side-effect bridge
 *  between IConfigurationService and settings.json), so the contribution owns
 *  its lifetime via createInstance. UserKeybindingsService is a registerSingleton
 *  service consumed elsewhere, so we resolve the same singleton via DI and only
 *  drive its initialize() here. Both initialize() calls are fire-and-forget —
 *  subscribers refresh via their own change events once hydration completes.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IInstantiationService,
  type IInstantiationService as IInstantiationServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { UserSettingsSync } from '../services/configuration/UserSettingsSync.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'

export class ConfigInitContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IInstantiationService instantiation: IInstantiationServiceType,
    @IUserKeybindingsService userKeybindings: IUserKeybindingsService,
  ) {
    super()
    const userSettingsSync = this._register(instantiation.createInstance(UserSettingsSync))
    void userSettingsSync.initialize()
    // UserKeybindingsService captures its default-keybinding snapshot in the
    // constructor, which happens when DI materializes it for this injection —
    // by BlockStartup every action's keybinding is already registered (actions
    // register at module load via contributions/index.js).
    void userKeybindings.initialize()
  }
}
