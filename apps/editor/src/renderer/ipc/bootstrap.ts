/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import {
  IpcService,
  formatIpcFrameAlert,
  setIpcEncodeInstrument,
  setIpcFrameDiagnostics,
  type ILogger,
  type IpcMessage,
} from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { formatBytes, slowPhaseInstrument } from '../services/performance/perfPhases.js'
import { RendererElectronProtocol } from './electronProtocol.js'

// Hoisted out of createRendererIpcService: the wrapper itself is constant per
// frame; only the byte length varies (carried by the lazily-evaluated detail).
const decodeSlow = (bytes: number) =>
  slowPhaseInstrument('ipc.decode', 5, () => `(${formatBytes(bytes)})`)

type FrameLogSink = Pick<ILogger, 'warn' | 'error'>

/**
 * Late-bound, because the ordering is forced: the frame guard has to be armed before the
 * first frame arrives, and frames start flowing the moment the first channel is proxied —
 * which is during DI construction, a hundred lines before the file-backed logger exists.
 * The console fallback covers only that window; in practice it never fires, since nothing
 * oversized crosses during the handshake.
 */
let frameLog: FrameLogSink | undefined

export function bindIpcFrameLog(logger: FrameLogSink): void {
  frameLog = logger
}

function emitFrameAlert(level: 'warn' | 'error', message: string): void {
  if (frameLog) {
    if (level === 'error') frameLog.error(message)
    else frameLog.warn(message)
  } else {
    console[level](message)
  }
}

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  // Attribute slow frame decodes/encodes (multi-MB payloads (de)serialize on the
  // main thread) so they surface as named phases in the interaction/tab-switch
  // reports. Decode additionally records the frame byte length so a 600ms
  // stall on a 100k-file workspace listing shows up as
  // "ipc.decode 615ms (14.2MB)" instead of an unattributed blob.
  setIpcEncodeInstrument(slowPhaseInstrument('ipc.encode'))
  // Surface what the frame guard refuses. Silently dropping an over-limit frame would
  // turn a size problem into an unexplained "this file will not open", and the whole
  // point of the guard is that the next crash report can name the payload.
  setIpcFrameDiagnostics({
    onWarn: (info) => emitFrameAlert('warn', `[ipc] ${formatIpcFrameAlert(info)}`),
    onOversized: (info) => emitFrameAlert('error', `[ipc] ${formatIpcFrameAlert(info)}`),
  })
  const decodeWithSize = (run: () => IpcMessage, bytes: number): IpcMessage =>
    decodeSlow(bytes)(run)
  return new IpcService(new RendererElectronProtocol(bridge), decodeWithSize)
}
