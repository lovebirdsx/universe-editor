/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import { IpcService, setIpcEncodeInstrument } from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { slowPhaseInstrument } from '../services/performance/perfPhases.js'
import { RendererElectronProtocol } from './electronProtocol.js'

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  // Attribute slow frame decodes/encodes (multi-MB payloads (de)serialize on the
  // main thread) so they surface as named phases in the interaction/tab-switch
  // reports.
  setIpcEncodeInstrument(slowPhaseInstrument('ipc.encode'))
  return new IpcService(new RendererElectronProtocol(bridge), slowPhaseInstrument('ipc.decode'))
}
