/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Instantiates the workbench Vim service at startup. The window-capture
 *  provider itself is installed by `useVimDispatcher` next to the global
 *  keybinding handler; this contribution only anchors the service so mode
 *  context keys and the status-bar entry exist before the first focus move.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution } from '@universe-editor/platform'
import { IVimModeService } from '../services/vim/vimModeService.js'

export class VimModeContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IVimModeService vimModeService: IVimModeService) {
    super()
    void vimModeService.getEnabled()
  }
}
