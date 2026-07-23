import {
  Disposable,
  Emitter,
  type Event,
  type IMessagePassingProtocol,
} from '@universe-editor/platform'

/**
 * The minimal byte-pump the framing protocol sits on top of. Both peers supply
 * one: the renderer wires `write` → `IExtensionHostService.writeStdin` and
 * `onData` → `onStdout`; the extension host wires `write` → `process.stdout`
 * and `onData` → `process.stdin`.
 */
export interface StdioTransport {
  /** Send one already-delimited frame (text ending in '\n') to the other side. */
  write(frame: string): void
  /** Raw, unframed text chunks from the other side (may split/coalesce frames). */
  readonly onData: Event<string>
}

/**
 * Turns a line-oriented stdio byte stream into an `IMessagePassingProtocol` so
 * the platform's ChannelServer/ChannelClient run unchanged over a child process.
 *
 * Framing: one message per line, delimited by '\n'. This is safe WITHOUT base64
 * because the only producer of `send()` payloads is the channel layer, which
 * encodes them as `TextEncoder().encode(JSON.stringify(msg))`. JSON escapes any
 * newline inside a string as the two characters `\` + `n`, so an encoded frame
 * never contains a raw 0x0A byte. Node's `setEncoding('utf8')` on the source
 * stream also guarantees chunks never split a multi-byte character.
 */
export class StdioFramingProtocol extends Disposable implements IMessagePassingProtocol {
  private readonly _onMessage = this._register(new Emitter<Uint8Array>())
  readonly onMessage = this._onMessage.event

  private readonly _encoder = new TextEncoder()
  private readonly _decoder = new TextDecoder()
  /** Partial-frame accumulator. Chunks are collected and joined only when the
   *  frame's newline arrives — `buffer += chunk` with a from-zero indexOf would
   *  re-copy and re-scan the whole prefix per chunk, turning one multi-MB frame
   *  (e.g. a huge didOpen) into O(n²) work: 820ms → 6ms for 15MB in 64KB chunks. */
  private _parts: string[] = []

  constructor(private readonly _transport: StdioTransport) {
    super()
    this._register(_transport.onData((chunk) => this._ingest(chunk)))
  }

  send(data: Uint8Array): void {
    this._transport.write(this._decoder.decode(data) + '\n')
  }

  private _ingest(chunk: string): void {
    let rest = chunk
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl < 0) {
        if (rest.length > 0) this._parts.push(rest)
        return
      }
      const head = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      const frame = this._parts.length > 0 ? this._parts.join('') + head : head
      if (this._parts.length > 0) this._parts = []
      if (frame.length > 0) {
        this._onMessage.fire(this._encoder.encode(frame))
      }
    }
  }
}
