/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadExtensions — the renderer end of activation lifecycle the host pushes
 *  up. Currently one signal: an extension's `activate` threw. The host isolates
 *  the failure (it never tears down the host), so without this the user would see
 *  a silently non-functional extension; we forward it to a sink that surfaces a
 *  notification + a per-extension error badge in the Extensions view.
 *--------------------------------------------------------------------------------------------*/

import type {
  IExtensionActivationErrorDto,
  IMainThreadExtensions,
} from '@universe-editor/extensions-common'

export class MainThreadExtensions implements IMainThreadExtensions {
  constructor(private readonly _onActivationError: (error: IExtensionActivationErrorDto) => void) {}

  $onActivationError(error: IExtensionActivationErrorDto): void {
    this._onActivationError(error)
  }
}
