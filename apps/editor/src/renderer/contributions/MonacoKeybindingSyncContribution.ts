/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-applies VSCode/user keybindings once monaco's EditorActions have been
 *  bridged into CommandsRegistry. Those commands register lazily (only when
 *  monaco loads), so bindings to monaco command ids in the read-only VSCode
 *  keybindings layer are skipped at startup by the command-existence filter in
 *  UserKeybindingsService._reloadVSCodeFile(). Mirrors ExtensionsContribution,
 *  which does the same for lazily-registered extension commands.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

export class MonacoKeybindingSyncContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IUserKeybindingsService userKeybindings: IUserKeybindingsService) {
    super()
    if (MonacoLoader.actionsBridged) {
      void userKeybindings.reload()
    } else {
      this._register(MonacoLoader.onDidBridgeActions(() => void userKeybindings.reload()))
    }
  }
}
