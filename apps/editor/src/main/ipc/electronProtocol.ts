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

const senderProtocols = new Map<number, ElectronProtocol>()
let dispatcherInstalled = false

function onIncoming(_event: IpcMainEvent, payload: unknown): void {
  // Find which renderer sent this — the sender id is on the event object.
  const sender = (_event as IpcMainEvent & { sender: WebContents }).sender
  const protocol = senderProtocols.get(sender.id)
  if (!protocol) return
  if (payload instanceof Uint8Array) {
    protocol.acceptMessage(payload)
  } else if (payload && typeof payload === 'object' && 'buffer' in (payload as object)) {
    // Node Buffer arrives as a Buffer instance; coerce to Uint8Array view without copy.
    const buf = payload as Buffer
    protocol.acceptMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }
}

export function installMainProtocolDispatcher(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  ipcMain.on(IPC_PROTOCOL_CHANNEL, onIncoming)
}

/**
 * Electron's own `webFrameMain.send` failure text. It is the *only* symptom a
 * gone-too-early frame produces: the send neither throws nor reports through any API, it
 * just console.errors once per attempt. Matching on it is how the console interceptor
 * turns that symptom into a gate closure — see `markRendererFramesUnreachable`.
 */
export const FRAME_SEND_FAILURE_PATTERN = /Error sending from web(FrameMain|Contents)/

/**
 * How long a gate stays shut on suspicion alone. The failure text names no window, so the
 * suspicion is applied to every window at once — a latched-forever gate would therefore
 * deafen healthy windows too (their event pushes are dropped with no replay until they
 * happen to send something). Bounding it caps that collateral at one rejected turn: a
 * healthy window reopens on its next `dom-ready`/`did-finish-load`, a dead one costs a
 * single failed send per window instead of one per event-loop turn.
 */
export const FRAME_UNREACHABLE_LATCH_MS = 30_000

/**
 * Close every window's protocol gate. Called when a frame-send failure is observed —
 * positive proof that a renderer is unreachable despite no `render-process-gone` having
 * arrived (the shipped crash had a ~48s window of exactly this, producing 225 failed
 * sends and a self-sustaining log loop).
 *
 * Deliberately does NOT fire `onDidClose`: that tears down ChannelServer subscriptions,
 * which is right for a *confirmed* dead renderer (`render-process-gone`) but not for one
 * inferred from a log line. Closing the gate alone already stops the retry loop — the
 * send short-circuits before touching Electron — and a frame that turns out to be alive
 * reopens it on its next inbound message, with its subscriptions intact.
 */
export function markRendererFramesUnreachable(): void {
  for (const protocol of senderProtocols.values()) {
    protocol.markFrameUnreachable()
  }
}

export class ElectronProtocol implements IMessagePassingProtocol {
  private readonly _emitter = new Emitter<Uint8Array>()
  readonly onMessage: Event<Uint8Array> = this._emitter.event
  // Fired when the frame can no longer receive anything (crash / window gone).
  // ChannelServer listens and tears down its event subscriptions, so a firing
  // service emitter no longer encodes a payload the gate below would drop.
  // Not fired for a reload navigation: the new frame's own subscriptions would
  // be cleared again while it is mid re-subscribe (subscribe replaces by key),
  // and reload re-subscriptions land AFTER the new frame's acceptMessage reopens
  // the gate — a close signal here could clear them with no later signal to
  // rebuild. A reload flood is bounded (new frame quickly reopens the gate); a
  // crash flood is not (48s+ before the OS notices), so only the latter fires.
  private readonly _closeEmitter = new Emitter<void>()
  readonly onDidClose: Event<void> = this._closeEmitter.event
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
  /**
   * Deadline until which document lifecycle events must not reopen the gate: after a crash
   * the old frame keeps emitting `dom-ready`-class events for a while, and each reopen
   * costs another failed send. Bounded rather than boolean — see
   * {@link FRAME_UNREACHABLE_LATCH_MS} for why.
   */
  private _suspectDeadUntil = 0
  private readonly _frameListeners: Array<{
    event: string
    handler: (...args: unknown[]) => void
  }> = []

  constructor(private readonly _webContents: WebContents) {
    this._senderId = _webContents.id
    senderProtocols.set(this._senderId, this)

    const wc = _webContents as unknown as {
      on(e: string, h: (...args: unknown[]) => void): void
    }
    const bind = (event: string, handler: (...args: unknown[]) => void): void => {
      // WebContents.on is heavily overloaded per event name; these lifecycle
      // events all carry payloads, so bind through a widened signature.
      wc.on(event, handler)
      this._frameListeners.push({ event, handler })
    }
    // A reload/navigation disposes the old frame before the new one commits;
    // during that window sends must be dropped. render-process-gone means the
    // frame is dead until an explicit reload rebuilds it.
    bind('render-process-gone', () => {
      this._frameAlive = false
      this._suspectDeadUntil = Date.now() + FRAME_UNREACHABLE_LATCH_MS
      this._closeEmitter.fire()
    })
    // Close the gate only for a MAIN-frame navigation (a reload). `did-start-loading`
    // was tempting but is WebContents-wide: an extension webview <iframe> navigating
    // to its blank doc fires it too, closing the gate — and nothing reopens it for a
    // subframe (dom-ready/did-finish-load only refire for the main frame), so the
    // main-frame IPC channel stays pinned shut forever and every custom-editor RPC
    // times out. `did-start-navigation` carries isMainFrame, so we can ignore
    // subframe loads. Same-document navigations (hashchange/pushState) keep the
    // frame alive.
    bind('did-start-navigation', (...args: unknown[]) => {
      const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
      if (details?.isMainFrame && !details.isSameDocument) {
        this._frameAlive = false
      }
    })
    // The new frame is ready to receive once the document commits. dom-ready fires
    // for the main frame's document; did-finish-load when the main navigation ends.
    // Both are refused while the dead-frame latch is running: they cannot tell a fresh
    // frame from a dying one, and the crash path is exactly where a late one reopens a
    // gate that should stay shut. An inbound message is the strongest proof and clears
    // the latch outright; past its deadline the gate reopens here as well, so a window
    // that never speaks first cannot stay deaf.
    bind('dom-ready', () => {
      if (!this._suspectDead()) this._frameAlive = true
    })
    bind('did-finish-load', () => {
      if (!this._suspectDead()) this._frameAlive = true
    })
  }

  private _suspectDead(): boolean {
    return Date.now() < this._suspectDeadUntil
  }

  /** Gate-closure entry point for the observed-send-failure path. */
  markFrameUnreachable(): void {
    this._frameAlive = false
    this._suspectDeadUntil = Date.now() + FRAME_UNREACHABLE_LATCH_MS
  }

  acceptMessage(data: Uint8Array): void {
    if (this._disposed) return
    // A message from the renderer proves the new frame is already executing IPC.
    // This can happen before dom-ready, so reopen the gate before ChannelServer
    // synchronously sends the response to this request. It is also the only signal
    // strong enough to clear the dead-frame latch — nothing else distinguishes a live
    // frame from a dead one.
    this._frameAlive = true
    this._suspectDeadUntil = 0
    this._emitter.fire(data)
  }

  /**
   * Whether the WebContents still has a usable main frame. Waits for no event: the
   * shipped crash went ~48s before `render-process-gone` arrived, during which an
   * event-driven gate stayed open and every send failed. `isCrashed()` and the frame's
   * own `isDestroyed()`/`detached` are the cheap checks that answer it immediately.
   */
  private _liveFrame(): boolean {
    if (this._webContents.isDestroyed() || this._webContents.isCrashed()) return false
    const frame = this._webContents.mainFrame
    return frame != null && !frame.isDestroyed() && !frame.detached
  }

  send(data: Uint8Array): void {
    // Gate already shut — a navigation is in flight, or the frame is known dead.
    // Drop quietly: treating this as fresh evidence would latch `_suspectDead` and
    // the lifecycle event that is supposed to reopen the gate would be refused.
    if (this._disposed || !this._frameAlive) return
    if (!this._liveFrame()) {
      // Latch rather than re-probe every send: the failure mode is a *flood*, and a
      // per-send probe would still emit one attempt per event-loop turn until an
      // event finally arrived.
      this.markFrameUnreachable()
      return
    }
    try {
      // Electron's structured clone serializes Buffer well; wrap to avoid losing typed-array identity.
      this._webContents.send(IPC_PROTOCOL_CHANNEL, Buffer.from(data))
    } catch {
      // Not the crash path — Electron 43's webFrameMain.send catches internally and
      // console.errors instead of throwing (that text is what the interceptor folds,
      // see FRAME_SEND_FAILURE_PATTERN). Kept for the frame-teardown race that does
      // still surface synchronously.
      this.markFrameUnreachable()
    }
  }

  disconnect(): void {
    if (this._disposed) return
    this._disposed = true
    this._frameAlive = false
    this._closeEmitter.fire()
    if (!this._webContents.isDestroyed()) {
      const wc = this._webContents as unknown as {
        removeListener(e: string, h: (...args: unknown[]) => void): void
      }
      for (const { event, handler } of this._frameListeners) {
        wc.removeListener(event, handler)
      }
    }
    this._frameListeners.length = 0
    senderProtocols.delete(this._senderId)
    this._emitter.dispose()
    this._closeEmitter.dispose()
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
