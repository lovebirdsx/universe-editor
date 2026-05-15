/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side Electron implementation of IMessagePassingProtocol.
 *  Wraps the thin `window.ipc` bridge exposed by the preload script.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event, type IMessagePassingProtocol } from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'

export class RendererElectronProtocol implements IMessagePassingProtocol {
  private readonly _emitter = new Emitter<Uint8Array>()
  readonly onMessage: Event<Uint8Array> = this._emitter.event
  private _detach: (() => void) | undefined

  constructor(private readonly _bridge: IpcBridge) {
    this._detach = _bridge.onMessage((data) => this._emitter.fire(data))
  }

  send(data: Uint8Array): void {
    this._bridge.send(data)
  }

  disconnect(): void {
    this._detach?.()
    this._detach = undefined
    this._emitter.dispose()
  }
}
