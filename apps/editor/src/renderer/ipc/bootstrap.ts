/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import { IpcService } from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { slowDecodePhaseInstrument } from '../services/performance/perfPhases.js'
import { RendererElectronProtocol } from './electronProtocol.js'

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  // Attribute slow frame decodes (multi-MB service responses parse on the main
  // thread) so they surface as named phases in the interaction/tab-switch reports.
  return new IpcService(
    new RendererElectronProtocol(bridge),
    slowDecodePhaseInstrument('ipc.decode'),
  )
}
