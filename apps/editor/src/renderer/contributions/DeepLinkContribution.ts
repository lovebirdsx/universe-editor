/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Opens a `universe-editor://` deep link routed here by the main process — at
 *  cold-launch (argv) or pushed over IPC to a live window. The main process has
 *  already reduced the link to an opener target (`path:line:col` or `command:…`);
 *  this just hands it to IOpenerService with the deep-link command whitelist, so
 *  a link can open a file at a position or invoke a safe configuration command,
 *  but never run an arbitrary command.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IOpenerService } from '@universe-editor/platform'
import type { IWorkbenchContribution } from '@universe-editor/platform'
import { DEEP_LINK_ALLOWED_COMMANDS } from '../../shared/deepLink.js'
import type { IpcBridge } from '../../preload/index.js'

export class DeepLinkContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IOpenerService private readonly _opener: IOpenerService) {
    super()
    const ipc = (window as { ipc?: IpcBridge }).ipc
    if (!ipc) return

    if (ipc.openUriTarget) this._open(ipc.openUriTarget)
    this._register({ dispose: ipc.onOpenUri((target) => this._open(target)) })
  }

  private _open(target: string): void {
    console.log(`[DeepLinkContribution] opening deep link: ${target}`)
    void this._opener.open(target, {
      allowCommands: DEEP_LINK_ALLOWED_COMMANDS,
      fromUserGesture: true,
    })
  }
}
