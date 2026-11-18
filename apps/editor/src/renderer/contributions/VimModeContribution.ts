/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Installs the Vim-mode switch for list navigation. `packages/workbench-ui` is
 *  DI-free, so the renderer owns the one global provider the registry consults
 *  on every keystroke; the editor's Vim controller is wired separately in
 *  FileEditor.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IWorkbenchContribution,
} from '@universe-editor/platform'
import { setVimListNavigationEnabledProvider } from '@universe-editor/workbench-ui'

export class VimModeContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IConfigurationService configService: IConfigurationService) {
    super()
    setVimListNavigationEnabledProvider(
      () => configService.get<boolean>('editor.vimMode.enabled') === true,
    )
    this._register({
      dispose: () => setVimListNavigationEnabledProvider(undefined),
    })
  }
}
