/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Instantiates the workbench Vim service at startup. The window-capture
 *  provider itself is installed by `useVimDispatcher` next to the global
 *  keybinding handler; this contribution anchors the service so mode context
 *  keys and the status-bar entry exist before the first focus move, and runs the
 *  input-method handoff for non-editor surfaces (`vim.autoSwitchInputMethod`).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IWorkbenchContribution,
} from '@universe-editor/platform'
import { IVimInputMethodService } from '../../shared/ipc/vimInputMethodService.js'
import { IVimModeService } from '../services/vim/vimModeService.js'
import { VimImeCoordinator } from '../workbench/vim/vimImeCoordinator.js'

export class VimModeContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IVimModeService vimModeService: IVimModeService,
    @IVimInputMethodService inputMethodService: IVimInputMethodService,
    @IConfigurationService configurationService: IConfigurationService,
  ) {
    super()
    this._register(new VimImeCoordinator(vimModeService, inputMethodService, configurationService))
  }
}
