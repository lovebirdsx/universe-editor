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
  // Gate that tracks whether the renderer frame can currently receive messages.
  // Sending to a disposed frame does NOT throw and isDestroyed() stays false, so
  // without this gate a dead frame keeps eating sends. Worse: each failed send
  // makes Electron internally console.error("Error sending from webFrameMain"),
  // which the main-process console interceptor turns into a log entry, whose
  // onDidAppendEntry fires back through this very protocol — an infinite
  // send→error→log→send loop that pins CPU and floods the disk. Closing this
  // gate the instant the frame goes away is what breaks that loop at the source.
  private _frameAlive = true
  private readonly _frameListeners: Array<{ event: string; handler: () => void }> = []

  constructor(private readonly _webContents: WebContents) {
    this._senderId = _webContents.id
    senderEmitters.set(this._senderId, this._emitter)

    const wc = _webContents as unknown as {
      on(e: string, h: (...args: unknown[]) => void): void
    }
    const bind = (event: string, handler: () => void): void => {
      // WebContents.on is heavily overloaded per event name; these lifecycle
      // events all carry payloads we ignore, so bind through a widened signature.
      wc.on(event, handler)
      this._frameListeners.push({ event, handler })
    }
    // A reload/navigation disposes the old frame before the new one commits;
    // during that window sends must be dropped. render-process-gone means the
    // frame is dead until an explicit reload rebuilds it.
    bind('render-process-gone', () => {
      this._frameAlive = false
    })
    bind('did-start-loading', () => {
      this._frameAlive = false
    })
    // The new frame is ready to receive once the document commits.
    bind('dom-ready', () => {
      this._frameAlive = true
    })
    bind('did-finish-load', () => {
      this._frameAlive = true
    })
  }

  send(data: Uint8Array): void {
    if (this._disposed || !this._frameAlive || this._webContents.isDestroyed()) return
    try {
      // Electron's structured clone serializes Buffer well; wrap to avoid losing typed-array identity.
      this._webContents.send(IPC_PROTOCOL_CHANNEL, Buffer.from(data))
    } catch {
      // Belt-and-suspenders: even with the _frameAlive gate a send can still race
      // a frame teardown that fired no observable event. Electron then throws
      // "Render frame was disposed before WebFrameMain could be accessed"; the
      // message is bound for a frame that no longer exists, so dropping it is
      // correct. Flip the gate closed so subsequent sends short-circuit here
      // instead of repeating the throw.
      this._frameAlive = false
    }
  }

  disconnect(): void {
    if (this._disposed) return
    this._disposed = true
    this._frameAlive = false
    if (!this._webContents.isDestroyed()) {
      const wc = this._webContents as unknown as {
        removeListener(e: string, h: (...args: unknown[]) => void): void
      }
      for (const { event, handler } of this._frameListeners) {
        wc.removeListener(event, handler)
      }
    }
    this._frameListeners.length = 0
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
