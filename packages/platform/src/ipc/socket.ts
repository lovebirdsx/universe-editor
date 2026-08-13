/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Transport-level socket abstraction for the remote tunnel (inspired by
 *  VSCode's base/parts/ipc/common/ipc.net.ts ISocket). Pure interface — no
 *  `net` import here; the node adapter lives in @universe-editor/node-services
 *  so this stays loadable in any process.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { IDisposable } from '../base/lifecycle.js'

export interface SocketCloseEvent {
  /** True when the socket closed due to a transmission error. */
  readonly hadError: boolean
  readonly error?: Error
}

/**
 * A full-duplex byte stream. `onClose` fires exactly once, whether the close
 * was local (`end()`), remote (FIN) or an error. Implementations must keep
 * delivering already-received data before firing `onClose`.
 */
export interface ISocket extends IDisposable {
  readonly onData: Event<Uint8Array>
  readonly onClose: Event<SocketCloseEvent>
  readonly onEnd: Event<void>
  write(buffer: Uint8Array): void
  /** Half-close: flush pending writes, then FIN. */
  end(): void
}
