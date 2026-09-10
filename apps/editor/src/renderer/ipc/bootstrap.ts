/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import { IpcService, setIpcEncodeInstrument, type IpcMessage } from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { formatBytes, slowPhaseInstrument } from '../services/performance/perfPhases.js'
import { RendererElectronProtocol } from './electronProtocol.js'

// Hoisted out of createRendererIpcService: the wrapper itself is constant per
// frame; only the byte length varies (carried by the lazily-evaluated detail).
const decodeSlow = (bytes: number) =>
  slowPhaseInstrument('ipc.decode', 5, () => `(${formatBytes(bytes)})`)

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  // Attribute slow frame decodes/encodes (multi-MB payloads (de)serialize on the
  // main thread) so they surface as named phases in the interaction/tab-switch
  // reports. Decode additionally records the frame byte length so a 600ms
  // stall on a 100k-file workspace listing shows up as
  // "ipc.decode 615ms (14.2MB)" instead of an unattributed blob.
  setIpcEncodeInstrument(slowPhaseInstrument('ipc.encode'))
  const decodeWithSize = (run: () => IpcMessage, bytes: number): IpcMessage =>
    decodeSlow(bytes)(run)
  return new IpcService(new RendererElectronProtocol(bridge), decodeWithSize)
}
