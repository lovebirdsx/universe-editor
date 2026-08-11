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

const NEWLINE = 0x0a
const NEWLINE_BYTES = new Uint8Array([NEWLINE])

/** A single stdout line larger than this is dropped instead of parsed. */
export const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024

/**
 * Per-line byte guard for agent stdout. The SDK's LineBuffer concatenates a
 * whole line before JSON.parse, so one pathological multi-hundred-MB frame
 * would be fully materialized and then parsed — enough to OOM the renderer.
 * This guard buffers a line only until its newline arrives (the SDK emits
 * nothing earlier anyway, so delivery latency is unchanged) and, once the
 * line exceeds the budget, releases the buffered prefix and discards the rest
 * of the line up to its terminating newline. The newline itself is forwarded:
 * the SDK silently skips the resulting empty line and the stream stays in
 * sync. `_onWarn` fires once per dropped line.
 */
export class StdoutLineGuard {
  private _pending: Uint8Array[] = []
  private _pendingBytes = 0
  private _dropping = false

  constructor(
    private readonly _onWarn: (message: string) => void,
    private readonly _maxLineBytes = MAX_STDOUT_LINE_BYTES,
  ) {}

  /** Push a stdout chunk; returns the byte segments safe to forward downstream. */
  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, start)
      const end = nl === -1 ? chunk.length : nl
      if (!this._dropping && end > start) {
        this._appendLinePart(chunk, start, end)
      }
      if (nl === -1) break
      if (this._dropping) {
        this._dropping = false
        out.push(NEWLINE_BYTES)
      } else {
        out.push(this._takeLine(NEWLINE_BYTES))
      }
      start = nl + 1
      if (start >= chunk.length) break
    }
    return out
  }

  /** Trailing unterminated bytes, for when the stream closes mid-line. */
  flush(): Uint8Array[] {
    if (this._dropping || this._pendingBytes === 0) {
      this._pending = []
      this._pendingBytes = 0
      this._dropping = false
      return []
    }
    const out = [this._takeLine()]
    return out
  }

  private _appendLinePart(chunk: Uint8Array, start: number, end: number): void {
    if (this._pendingBytes + (end - start) > this._maxLineBytes) {
      this._pending = []
      this._pendingBytes = 0
      this._dropping = true
      this._onWarn(
        `agent stdout line exceeded ${this._maxLineBytes} bytes — dropping the line to protect the renderer heap`,
      )
      return
    }
    // Copy the retained part so a few carried bytes don't pin the whole chunk.
    this._pending.push(chunk.slice(start, end))
    this._pendingBytes += end - start
  }

  private _takeLine(suffix?: Uint8Array): Uint8Array {
    const line = new Uint8Array(this._pendingBytes + (suffix?.length ?? 0))
    let offset = 0
    for (const part of this._pending) {
      line.set(part, offset)
      offset += part.length
    }
    if (suffix) line.set(suffix, offset)
    this._pending = []
    this._pendingBytes = 0
    return line
  }
}

class SdkHostStreamImpl extends Disposable implements SdkHostStream {
  readonly stream: Stream
  private _readableClosed = false
  private _stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
  private readonly _stdoutGuard = new StdoutLineGuard((message) =>
    console.warn(`[sdkHostStream] ${message}`),
  )

  constructor(host: IAcpHostService, handle: string, tap?: SdkHostStreamTap) {
    super()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    this._register(
      host.onStdout((chunk: AcpStdioChunk) => {
        if (chunk.handle !== handle || this._readableClosed) return
        tap?.onStdout?.(chunk.data)
        for (const part of this._stdoutGuard.push(encoder.encode(chunk.data))) {
          this._stdoutController?.enqueue(part)
        }
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
      // The guard buffers until a newline; a final line the agent never
      // terminated would otherwise vanish on close.
      for (const part of this._stdoutGuard.flush()) {
        this._stdoutController?.enqueue(part)
      }
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
