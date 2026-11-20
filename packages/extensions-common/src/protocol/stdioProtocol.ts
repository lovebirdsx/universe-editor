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

/** A single frame's backing store may never grow past this, newline or not. */
export const DEFAULT_MAX_PENDING_FRAME_BYTES = 64 * 1024 * 1024

export interface StdioFramingProtocolOptions {
  /**
   * Cap on the accumulated bytes of a frame that has not yet seen its newline.
   * A peer that never terminates a frame would otherwise buffer without bound.
   * Counted in UTF-16 code units (≈ bytes for the ASCII-dominant JSON wire).
   */
  readonly maxPendingFrameBytes?: number
  /**
   * Fired once when a partial frame crosses the cap. The partial frame is
   * dropped and no further inbound data is parsed — the owner must treat the
   * stream as desynchronized and tear the connection down (the renderer stops
   * the host; the host exits).
   */
  readonly onOverflow?: (info: { readonly pendingBytes: number; readonly limit: number }) => void
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
  private readonly _maxPendingFrameBytes: number
  private readonly _onOverflow: StdioFramingProtocolOptions['onOverflow']
  /** Partial-frame accumulator. Chunks are collected and joined only when the
   *  frame's newline arrives — `buffer += chunk` with a from-zero indexOf would
   *  re-copy and re-scan the whole prefix per chunk, turning one multi-MB frame
   *  (e.g. a huge didOpen) into O(n²) work: 820ms → 6ms for 15MB in 64KB chunks. */
  private _parts: string[] = []
  private _pendingBytes = 0
  private _overflowed = false

  constructor(
    private readonly _transport: StdioTransport,
    options: StdioFramingProtocolOptions = {},
  ) {
    super()
    this._maxPendingFrameBytes = options.maxPendingFrameBytes ?? DEFAULT_MAX_PENDING_FRAME_BYTES
    this._onOverflow = options.onOverflow
    this._register(_transport.onData((chunk) => this._ingest(chunk)))
  }

  send(data: Uint8Array): void {
    this._transport.write(this._decoder.decode(data) + '\n')
  }

  private _ingest(chunk: string): void {
    // A desynchronized stream cannot produce trusted frames; stay silent rather
    // than parsing (and firing) garbage from the remainder of the pipe.
    if (this._overflowed) return
    let rest = chunk
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl < 0) {
        if (rest.length > 0) {
          this._parts.push(rest)
          this._pendingBytes += rest.length
        }
        this._checkPendingFrame()
        return
      }
      const head = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      const frame = this._parts.length > 0 ? this._parts.join('') + head : head
      this._parts = []
      this._pendingBytes = 0
      if (frame.length > 0) {
        this._onMessage.fire(this._encoder.encode(frame))
      }
    }
  }

  private _checkPendingFrame(): void {
    if (this._pendingBytes <= this._maxPendingFrameBytes) return
    this._overflowed = true
    const pendingBytes = this._pendingBytes
    this._parts = []
    this._pendingBytes = 0
    try {
      this._onOverflow?.({ pendingBytes, limit: this._maxPendingFrameBytes })
    } catch {
      /* observability is not a protocol failure */
    }
  }
}

const EVENT_FRAME_PREFIX = '{"type":"event","channel":"'
const EVENT_FRAME_MIDDLE = '","event":"'

/**
 * Cheaply recognize an `EventMessage` frame and return its `channel:event`
 * routing key, or `undefined` for every other frame kind.
 *
 * Key order is load-bearing: `ChannelServer` builds events as
 * `{ type, channel, event, data }` and the JSON codec preserves insertion
 * order, so the prefix is exact. A test feeds frames produced by a real
 * `ChannelServer`/`ChannelPair` through this helper so a future field reorder
 * fails loudly instead of silently disabling coalescing.
 *
 * Channel and event names are JSON identifiers without escapes (they are
 * TypeScript property names), so slicing between the delimiters is safe and
 * does not pay for a full `JSON.parse` on the hot path.
 */
export function eventFrameKey(frame: string): string | undefined {
  if (!frame.startsWith(EVENT_FRAME_PREFIX)) return undefined
  const channelStart = EVENT_FRAME_PREFIX.length
  const channelEnd = frame.indexOf(EVENT_FRAME_MIDDLE, channelStart)
  if (channelEnd < 0) return undefined
  const eventStart = channelEnd + EVENT_FRAME_MIDDLE.length
  const eventEnd = frame.indexOf('"', eventStart)
  if (eventEnd < 0) return undefined
  return `${frame.slice(channelStart, channelEnd)}:${frame.slice(eventStart, eventEnd)}`
}
