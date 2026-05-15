/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import { IpcService } from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { RendererElectronProtocol } from './electronProtocol.js'

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  return new IpcService(new RendererElectronProtocol(bridge))
}
