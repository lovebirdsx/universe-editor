/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Seeds the `hasWslDistros` context key that gates the "WSL Targets" view's
 *  `when` clause — the whole view is hidden while no WSL distro is known,
 *  mirroring the old inline conditional section.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IContextKeyService,
  autorun,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IRemoteExplorerService } from '../services/remote/RemoteExplorerService.js'

export class RemoteExplorerContextContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IRemoteExplorerService explorerService: IRemoteExplorerService,
  ) {
    super()

    const hasWslDistros = contextKeyService.createKey<boolean>('hasWslDistros', false)
    this._register(
      autorun((r) => {
        hasWslDistros.set(explorerService.wslDistros.read(r).length > 0)
      }),
    )
  }
}
