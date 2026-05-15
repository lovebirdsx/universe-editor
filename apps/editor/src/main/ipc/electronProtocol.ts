/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side Electron implementation of IMessagePassingProtocol.
 *
 *  All renderer<->main IPC is multiplexed onto a single Electron channel
 *  (IPC_PROTOCOL_CHANNEL). A module-level dispatcher routes incoming messages
 *  by WebContents id to per-window emitters so each BrowserWindow has its own
 *  protocol/ChannelServer pair.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import {
  Emitter,
  type Event,
  type IDisposable,
  type IMessagePassingProtocol,
  toDisposable,
} from '@universe-editor/platform'
import { IPC_PROTOCOL_CHANNEL } from '../../shared/ipc/channelNames.js'

const senderEmitters = new Map<number, Emitter<Uint8Array>>()
let dispatcherInstalled = false

function onIncoming(_event: IpcMainEvent, payload: unknown): void {
  // Find which renderer sent this — the sender id is on the event object.
  const sender = (_event as IpcMainEvent & { sender: WebContents }).sender
  const emitter = senderEmitters.get(sender.id)
  if (!emitter) return
  if (payload instanceof Uint8Array) {
    emitter.fire(payload)
  } else if (payload && typeof payload === 'object' && 'buffer' in (payload as object)) {
    // Node Buffer arrives as a Buffer instance; coerce to Uint8Array view without copy.
    const buf = payload as Buffer
    emitter.fire(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }
}

export function installMainProtocolDispatcher(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  ipcMain.on(IPC_PROTOCOL_CHANNEL, onIncoming)
}

export class ElectronProtocol implements IMessagePassingProtocol {
  private readonly _emitter = new Emitter<Uint8Array>()
  readonly onMessage: Event<Uint8Array> = this._emitter.event
  private _disposed = false
  private readonly _senderId: number

  constructor(private readonly _webContents: WebContents) {
    this._senderId = _webContents.id
    senderEmitters.set(this._senderId, this._emitter)
  }

  send(data: Uint8Array): void {
    if (this._disposed || this._webContents.isDestroyed()) return
    // Electron's structured clone serializes Buffer well; wrap to avoid losing typed-array identity.
    this._webContents.send(IPC_PROTOCOL_CHANNEL, Buffer.from(data))
  }

  disconnect(): void {
    if (this._disposed) return
    this._disposed = true
    senderEmitters.delete(this._senderId)
    this._emitter.dispose()
  }
}

/**
 * Create an ElectronProtocol bound to a BrowserWindow's WebContents. The
 * protocol is automatically disconnected when the renderer is destroyed.
 */
export function createMainProtocolForWindow(win: BrowserWindow): {
  protocol: ElectronProtocol
  disposable: IDisposable
} {
  const webContents = win.webContents
  const protocol = new ElectronProtocol(webContents)
  const onDestroyed = (): void => protocol.disconnect()
  webContents.once('destroyed', onDestroyed)
  const disposable = toDisposable(() => {
    if (!webContents.isDestroyed()) {
      webContents.removeListener('destroyed', onDestroyed)
    }
    protocol.disconnect()
  })
  return { protocol, disposable }
}
