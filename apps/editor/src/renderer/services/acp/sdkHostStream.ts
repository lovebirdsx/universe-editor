/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapter that bridges `IAcpHostService` (string-based stdio bytestream over
 *  IPC) into the SDK's `Stream<AnyMessage>` expected by `ClientSideConnection`.
 *
 *  The SDK is byte-oriented: `ndJsonStream` takes a `WritableStream<Uint8Array>`
 *  and a `ReadableStream<Uint8Array>` and gives back a message-typed stream.
 *  Our host emits decoded text chunks, so we re-encode on the read side and
 *  re-decode on the write side. stderr is *not* wired into the SDK stream — it
 *  stays a host-level event so callers can route it into an OutputChannel.
 *--------------------------------------------------------------------------------------------*/

import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import { Disposable } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../shared/ipc/acpHostService.js'

export interface SdkHostStream extends Disposable {
  readonly stream: Stream
}

export interface SdkHostStreamTap {
  onStdout?(text: string): void
  onStdin?(text: string): void
}

class SdkHostStreamImpl extends Disposable implements SdkHostStream {
  readonly stream: Stream
  private _readableClosed = false
  private _stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined

  constructor(host: IAcpHostService, handle: string, tap?: SdkHostStreamTap) {
    super()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    this._register(
      host.onStdout((chunk: AcpStdioChunk) => {
        if (chunk.handle !== handle || this._readableClosed) return
        tap?.onStdout?.(chunk.data)
        this._stdoutController?.enqueue(encoder.encode(chunk.data))
      }),
    )

    this._register(
      host.onExit((evt: AcpExitEvent) => {
        if (evt.handle !== handle) return
        this._closeReadable()
      }),
    )

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this._stdoutController = controller
      },
      cancel: () => {
        this._readableClosed = true
      },
    })

    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        const text = decoder.decode(chunk)
        tap?.onStdin?.(text)
        await host.writeStdin(handle, text)
      },
    })

    this.stream = ndJsonStream(writable, readable)
  }

  private _closeReadable(): void {
    if (this._readableClosed) return
    this._readableClosed = true
    try {
      this._stdoutController?.close()
    } catch {
      // already closed by cancel/error
    }
  }

  override dispose(): void {
    super.dispose()
    this._closeReadable()
  }
}

/**
 * Wrap a running agent (identified by `handle`) into an ACP SDK `Stream`.
 *
 * Lifecycle:
 * - `onStdout` chunks for `handle` are encoded to UTF-8 and pushed into the
 *   readable side.
 * - `onExit` for `handle` closes the readable side, which causes the SDK
 *   connection to settle its `closed` promise.
 * - Writing to the writable side decodes UTF-8 back to text and forwards via
 *   `writeStdin(handle, ...)`.
 * - The adapter does **not** call `host.stop` on its own — `ndJsonStream`
 *   never propagates close to its underlying byte writable. Callers are
 *   responsible for invoking `host.stop(handle)` when they're done.
 */
export function createSdkHostStream(
  host: IAcpHostService,
  handle: string,
  tap?: SdkHostStreamTap,
): SdkHostStream {
  return new SdkHostStreamImpl(host, handle, tap)
}
