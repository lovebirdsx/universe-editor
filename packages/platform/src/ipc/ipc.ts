/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IPC framework (base/parts/ipc/common/ipc.ts).
 *  M1 scope: abstraction layer only. Electron adapter lives in apps/editor (M2).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IDisposable,
  markAsSingleton,
  toDisposable,
} from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'
import { URI, type UriComponents } from '../base/uri.js'
import { CancellationToken, CancellationTokenSource } from '../base/cancellation.js'
import { CancellationError } from '../base/errors.js'

// -------- Transport abstraction --------

/**
 * The lowest-level transport abstraction. Decouples the channel layer from the
 * specific transport mechanism (Electron IPC, WebSocket, in-memory, etc.).
 */
export interface IMessagePassingProtocol {
  /** Send raw data to the other side. */
  send(data: Uint8Array): void
  /** Fired when the other side sends data. */
  readonly onMessage: Event<Uint8Array>
  /**
   * Optional: fired once when the transport can no longer deliver messages to
   * the other side (e.g. the renderer frame died). ChannelServer clears all
   * event subscriptions on this signal so a firing emitter does not keep
   * encoding payloads that can never arrive; a recovered peer re-subscribes
   * and the subscriptions are rebuilt.
   */
  readonly onDidClose?: Event<void>
  /** Optional: disconnect / close the transport. */
  disconnect?(): void
}

// -------- Channel abstraction --------

/**
 * A typed communication channel.
 * - `call` is request/response (returns a Promise). An optional
 *   `CancellationToken` propagates cancellation to the remote handler and, on
 *   the client, rejects the pending promise with `CancellationError`.
 * - `listen` is push-based (returns an Event).
 */
export interface IChannel {
  call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T>
  listen<T>(event: string, arg?: unknown): Event<T>
}

export interface IChannelClient {
  getChannel(channelName: string): IChannel
}

export interface IChannelServer extends IDisposable {
  registerChannel(channelName: string, channel: IChannel): void
}

// -------- In-memory protocol (for testing) --------

/**
 * Two connected in-memory protocols that forward messages to each other.
 * Useful for unit testing channel implementations without real IPC.
 */
export class InMemoryMessagePassingProtocol implements IMessagePassingProtocol {
  private _peer: InMemoryMessagePassingProtocol | null = null
  private readonly _onMessage = new Emitter<Uint8Array>()
  readonly onMessage = this._onMessage.event

  static createPair(): [InMemoryMessagePassingProtocol, InMemoryMessagePassingProtocol] {
    const a = new InMemoryMessagePassingProtocol()
    const b = new InMemoryMessagePassingProtocol()
    a._peer = b
    b._peer = a
    return [a, b]
  }

  send(data: Uint8Array): void {
    if (this._peer) {
      // Simulate async delivery to avoid synchronous re-entrancy
      queueMicrotask(() => this._peer!._onMessage.fire(data))
    }
  }

  disconnect(): void {
    this._peer = null
  }
}

// -------- Simple JSON-based channel implementation --------

type RequestMessage = {
  type: 'request'
  id: number
  channel: string
  command: string
  arg: unknown
  // Set only when the caller passed a CancellationToken. The server must not
  // append a token to the handler args otherwise: service methods with an
  // optional trailing parameter (`readFileText(uri, encoding = 'utf8')`) would
  // silently receive the token in that slot and misbehave.
  hasToken?: true
}

type ResponseMessage = {
  type: 'response'
  id: number
  data?: unknown
  error?: WireError
}

/**
 * Structured error carried over the wire. Preserves the error's `name` and an
 * optional machine-readable `code` so the remote side can branch on identity
 * instead of pattern-matching the human `message` (which breaks the moment the
 * wording changes). `message` is always present; older peers that sent a bare
 * string are tolerated on decode (see {@link reviveWireError}).
 */
type WireError = {
  name: string
  message: string
  code?: string | number
}

type EventMessage = {
  type: 'event'
  channel: string
  event: string
  data: unknown
}

type SubscribeMessage = {
  type: 'subscribe'
  channel: string
  event: string
  arg?: unknown
}

type UnsubscribeMessage = {
  type: 'unsubscribe'
  channel: string
  event: string
}

type CancelMessage = {
  type: 'cancel'
  id: number
}

type IpcMessage =
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | CancelMessage

export type { IpcMessage }

/**
 * Rejection reason for any request still pending when a {@link ChannelClient} is
 * disposed (e.g. its window closed). Named so callers can distinguish a torn-down
 * channel from a genuine remote error and swallow it during shutdown.
 */
export class IpcChannelDisposedError extends Error {
  readonly code = 'IPC_CHANNEL_DISPOSED'
  constructor(message = 'IPC channel disposed before response') {
    super(message)
    this.name = 'IpcChannelDisposedError'
  }
}

// Binary payloads (file contents, etc.) must survive the JSON envelope: a raw
// `Uint8Array` would stringify to `{"0":..,"1":..}` and revive as a plain object
// (no `.length`/`.subarray`), silently corrupting binary IPC. Tag every byte
// array as base64 on the way out and rebuild it on the way in. `Buffer` is a
// `Uint8Array`, so this covers main-process reads too.
export const U8_TAG = '$u8'
const B64_CHUNK = 0x8000

// URIs must survive the envelope as real `URI` instances, not bare
// `UriComponents`. `URI.toJSON()` already stamps `{ $mid: 1, scheme, ... }` when
// `JSON.stringify` walks a URI (so the replacer needs nothing), but the parse
// side would otherwise hand back a plain object with no `.fsPath`/`.with()` —
// forcing 50+ call sites to remember a manual `URI.revive`. The reviver rebuilds
// any `$mid: 1` object into a URI, killing that whole class of "forgot to revive"
// bugs. `URI.revive` is idempotent, so existing manual calls stay safe.
const URI_MID = 1

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { [U8_TAG]: bytesToBase64(value) } : value
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj[U8_TAG] === 'string') return base64ToBytes(obj[U8_TAG] as string)
    // A `$mid: 1` object is a serialized URI (see URI.toJSON). Revive it to a real
    // instance. Guarded on scheme being a string so a hostile/garbage payload
    // can't crash `URI.from`; falls through to the plain object otherwise.
    if (obj['$mid'] === URI_MID && typeof obj['scheme'] === 'string') {
      return URI.revive(obj as unknown as UriComponents)
    }
  }
  return value
}

let encodeInstrument: (<T>(run: () => T) => T) | undefined

/** Optional hook wrapping every outgoing-message encode in this process, so the
 *  embedder can attribute slow serializations (multi-MB payloads stringify on the
 *  main thread) instead of them showing up as anonymous long tasks. */
export function setIpcEncodeInstrument(instrument: (<T>(run: () => T) => T) | undefined): void {
  encodeInstrument = instrument
}

function encode(msg: IpcMessage): Uint8Array {
  const run = () => new TextEncoder().encode(JSON.stringify(msg, replacer))
  return encodeInstrument ? encodeInstrument(run) : run()
}

function decode(data: Uint8Array): IpcMessage {
  return JSON.parse(new TextDecoder().decode(data), reviver) as IpcMessage
}

/**
 * Pluggable wire format for the channel layer. `defaultCodec` is the historical
 * JSON + base64-tagged-Uint8Array envelope (byte-for-byte identical to before
 * the codec seam existed) and is what Electron IPC / the extension host / tests
 * keep using implicitly. The remote tunnel injects a binary codec (see
 * `codec.ts`) that carries Uint8Array payloads as raw attachment segments and
 * hooks per-connection URI transformation into the same pass.
 */
export interface IpcCodec {
  encode(msg: IpcMessage): Uint8Array
  decode(data: Uint8Array): IpcMessage
}

export const defaultCodec: IpcCodec = { encode, decode }

/** Field an `Error` may carry a machine-readable code under (matches Node's `err.code`). */
interface ErrorWithCode extends Error {
  code?: string | number
}

/** Serialize a thrown value into the structured wire form (preserves name/code). */
function serializeError(err: unknown): WireError {
  if (err instanceof Error) {
    const code = (err as ErrorWithCode).code
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    }
  }
  return { name: 'Error', message: String(err) }
}

/**
 * Rebuild an `Error` from the wire form, restoring `name` and (if present) `code`.
 * Tolerates the legacy shape where `error` was a bare message string so a new
 * client can still talk to an old server mid-rollout.
 */
function reviveWireError(wire: WireError | string | undefined): Error {
  if (typeof wire === 'string') return new Error(wire)
  if (!wire) return new Error('Unknown IPC error')
  const err: ErrorWithCode = new Error(wire.message)
  if (wire.name) err.name = wire.name
  if (wire.code !== undefined) err.code = wire.code
  return err
}

/**
 * Client side: sends requests over a protocol and routes responses back to callers.
 * Also receives event messages and fires them on local Emitters.
 */
export class ChannelClient extends Disposable implements IChannelClient {
  private _requestId = 0
  private _disposed = false
  private readonly _pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly _eventEmitters = new Map<string, Emitter<unknown>>()
  // Owns the cancellation subscriptions of in-flight requests. Deliberately a
  // parentless singleton store (not _register'ed): the subscriptions are alive
  // by design until the request settles, so teardown leak snapshots must not
  // flag them — dispose() below still clears them with the pending requests.
  private readonly _inflightCancelListeners = markAsSingleton(new DisposableStore())

  constructor(
    private readonly _protocol: IMessagePassingProtocol,
    autoDispatch = true,
    private readonly _codec: IpcCodec = defaultCodec,
  ) {
    super()
    // A ChannelPair shares the protocol with a ChannelServer and dispatches
    // decoded messages itself — decoding every frame twice on multi-MB payloads
    // is exactly the main-thread stall the pair exists to avoid.
    if (autoDispatch) {
      this._register(_protocol.onMessage((data) => this.handleMessage(this._codec.decode(data))))
    }
  }

  handleMessage(msg: IpcMessage): void {
    if (msg.type === 'response') {
      const pending = this._pendingRequests.get(msg.id)
      if (pending) {
        this._pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(reviveWireError(msg.error))
        } else {
          pending.resolve(msg.data)
        }
      }
    } else if (msg.type === 'event') {
      const key = `${msg.channel}:${msg.event}`
      this._eventEmitters.get(key)?.fire(msg.data)
    }
  }

  getChannel(channelName: string): IChannel {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this
    return {
      call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
        if (token?.isCancellationRequested) {
          return Promise.reject(new CancellationError())
        }
        const id = ++client._requestId
        return new Promise<T>((resolve, reject) => {
          // Cancellation notifies the server (so a long-running handler can
          // stop early) and settles the local promise immediately. Settle via
          // the pending wrapper so the token subscription itself is disposed.
          const cancelListener = token?.onCancellationRequested(() => {
            const pending = client._pendingRequests.get(id)
            if (!pending) return
            client._pendingRequests.delete(id)
            if (!client._disposed) {
              client._protocol.send(client._codec.encode({ type: 'cancel', id }))
            }
            pending.reject(new CancellationError())
          })
          if (cancelListener) {
            client._inflightCancelListeners.add(cancelListener)
          }
          client._pendingRequests.set(id, {
            resolve: (v) => {
              if (cancelListener) client._inflightCancelListeners.delete(cancelListener)
              resolve(v as T)
            },
            reject: (e) => {
              if (cancelListener) client._inflightCancelListeners.delete(cancelListener)
              reject(e)
            },
          })
          client._protocol.send(
            client._codec.encode({
              type: 'request',
              id,
              channel: channelName,
              command,
              arg,
              ...(token !== undefined ? { hasToken: true as const } : {}),
            }),
          )
        })
      },
      listen<T>(event: string, arg?: unknown): Event<T> {
        const key = `${channelName}:${event}`
        let emitter = client._eventEmitters.get(key)
        if (!emitter) {
          emitter = new Emitter<unknown>({
            onDidAddFirstListener: () => {
              client._protocol.send(
                client._codec.encode({ type: 'subscribe', channel: channelName, event, arg }),
              )
            },
            onDidRemoveLastListener: () => {
              if (client._disposed) {
                return
              }
              client._protocol.send(
                client._codec.encode({ type: 'unsubscribe', channel: channelName, event }),
              )
            },
          })
          client._eventEmitters.set(key, emitter)
        }
        return emitter.event as Event<T>
      },
    }
  }

  override dispose(): void {
    this._disposed = true
    // Reject every in-flight request so callers awaiting a response don't hang
    // forever once the transport is gone (window closed / renderer torn down).
    if (this._pendingRequests.size > 0) {
      const err = new IpcChannelDisposedError()
      for (const pending of this._pendingRequests.values()) {
        pending.reject(err)
      }
      this._pendingRequests.clear()
    }
    this._inflightCancelListeners.dispose()
    for (const emitter of this._eventEmitters.values()) {
      emitter.dispose()
    }
    this._eventEmitters.clear()
    super.dispose()
  }
}

/**
 * Server side: receives requests, routes them to registered channels, sends responses.
 * Also allows channels to push events to the client.
 */
export class ChannelServer extends Disposable implements IChannelServer {
  private readonly _channels = new Map<string, IChannel>()
  private readonly _eventSubscriptions = new Map<string, IDisposable>()
  private readonly _pendingCancellations = new Map<number, CancellationTokenSource>()

  constructor(
    private readonly _protocol: IMessagePassingProtocol,
    autoDispatch = true,
    private readonly _codec: IpcCodec = defaultCodec,
  ) {
    super()
    if (autoDispatch) {
      this._register(_protocol.onMessage((data) => this.handleMessage(this._codec.decode(data))))
    }
    // A dead peer (renderer frame gone) cannot receive anything, but every
    // firing emitter would still encode its payload only for the protocol's
    // liveness gate to drop the bytes — pure allocation churn. Tear the
    // subscriptions down instead: a recovered peer re-subscribes through the
    // replace path in _handleSubscribe.
    if (_protocol.onDidClose) {
      this._register(_protocol.onDidClose(() => this._clearEventSubscriptions()))
    }
  }

  registerChannel(channelName: string, channel: IChannel): void {
    this._channels.set(channelName, channel)
  }

  handleMessage(msg: IpcMessage): void {
    if (msg.type === 'request') {
      this._handleRequest(msg)
    } else if (msg.type === 'subscribe') {
      this._handleSubscribe(msg)
    } else if (msg.type === 'unsubscribe') {
      this._handleUnsubscribe(msg)
    } else if (msg.type === 'cancel') {
      this._pendingCancellations.get(msg.id)?.cancel()
    }
  }

  private _handleRequest(msg: RequestMessage): void {
    const { id, channel: channelName, command, arg } = msg
    const channel = this._channels.get(channelName)

    if (!channel) {
      this._protocol.send(
        this._codec.encode({
          type: 'response',
          id,
          error: { name: 'ChannelNotFoundError', message: `Channel '${channelName}' not found` },
        }),
      )
      return
    }

    // Only calls that declared a token get one server-side: handlers then see
    // client cancellation and server teardown (window closed mid-flight).
    // Token-less calls keep their exact original argument shape.
    if (!msg.hasToken) {
      channel
        .call(command, arg)
        .then((data) => {
          this._protocol.send(this._codec.encode({ type: 'response', id, data }))
        })
        .catch((err: unknown) => {
          this._protocol.send(
            this._codec.encode({ type: 'response', id, error: serializeError(err) }),
          )
        })
      return
    }

    const cts = new CancellationTokenSource()
    this._pendingCancellations.set(id, cts)
    const finish = (): void => {
      this._pendingCancellations.delete(id)
      cts.dispose()
    }

    channel
      .call(command, arg, cts.token)
      .then((data) => {
        finish()
        this._protocol.send(this._codec.encode({ type: 'response', id, data }))
      })
      .catch((err: unknown) => {
        finish()
        this._protocol.send(
          this._codec.encode({ type: 'response', id, error: serializeError(err) }),
        )
      })
  }

  private _handleSubscribe(msg: SubscribeMessage): void {
    const { channel: channelName, event, arg } = msg
    const channel = this._channels.get(channelName)
    if (!channel) return

    const key = `${channelName}:${event}`
    // Re-subscription should replace any prior subscription.
    this._eventSubscriptions.get(key)?.dispose()

    const sub = channel.listen<unknown>(
      event,
      arg,
    )((data) => {
      this._protocol.send(this._codec.encode({ type: 'event', channel: channelName, event, data }))
    })
    this._eventSubscriptions.set(key, sub)
  }

  private _handleUnsubscribe(msg: UnsubscribeMessage): void {
    const key = `${msg.channel}:${msg.event}`
    this._eventSubscriptions.get(key)?.dispose()
    this._eventSubscriptions.delete(key)
  }

  private _clearEventSubscriptions(): void {
    for (const sub of this._eventSubscriptions.values()) {
      sub.dispose()
    }
    this._eventSubscriptions.clear()
  }

  override dispose(): void {
    // Cancel in-flight handlers first: a torn-down window must not leave
    // long-running work (e.g. a workspace walk) running in this process.
    for (const cts of this._pendingCancellations.values()) {
      cts.cancel()
      cts.dispose()
    }
    this._pendingCancellations.clear()
    this._clearEventSubscriptions()
    super.dispose()
  }
}

/**
 * Client + server sharing one full-duplex protocol with a SINGLE decode per
 * frame. Wiring a standalone ChannelClient AND ChannelServer onto the same
 * protocol makes both sides JSON-parse every incoming message only for one of
 * them to discard it — on multi-MB frames (language-service responses crossing
 * the extension-host tunnel) that doubles the main-thread stall. The pair
 * decodes once and routes by message type instead.
 *
 * `decodeInstrument` optionally wraps each decode so the embedder can attribute
 * its wall time (e.g. the renderer records a perf phase for slow decodes).
 */
export class ChannelPair extends Disposable {
  readonly client: ChannelClient
  readonly server: ChannelServer

  constructor(
    protocol: IMessagePassingProtocol,
    decodeInstrument?: (run: () => IpcMessage) => IpcMessage,
    codec: IpcCodec = defaultCodec,
  ) {
    super()
    this.client = this._register(new ChannelClient(protocol, false, codec))
    this.server = this._register(new ChannelServer(protocol, false, codec))
    this._register(
      protocol.onMessage((data) => {
        const msg = decodeInstrument
          ? decodeInstrument(() => codec.decode(data))
          : codec.decode(data)
        if (msg.type === 'response' || msg.type === 'event') {
          this.client.handleMessage(msg)
        } else {
          this.server.handleMessage(msg)
        }
      }),
    )
  }
}

/**
 * Helper: create a simple IChannel from a plain object of command handlers and events.
 */
export function createChannelFromObject(obj: {
  [command: string]: (...args: unknown[]) => unknown
}): IChannel {
  return {
    call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
      const handler = obj[command]
      if (typeof handler !== 'function') {
        return Promise.reject(new Error(`Unknown command: ${command}`))
      }
      try {
        return Promise.resolve(handler(arg, token) as T)
      } catch (e) {
        return Promise.reject(e)
      }
    },
    listen<T>(_event: string, _arg?: unknown): Event<T> {
      return Event.None
    },
  }
}

// -------- IPC Service --------

import { createDecorator } from '../di/instantiation.js'

export interface IIpcService {
  readonly _serviceBrand: undefined
  getChannel(channelName: string): IChannel
  registerChannel(channelName: string, channel: IChannel): void
}

export const IIpcService = createDecorator<IIpcService>('ipcService')

export class IpcService extends Disposable implements IIpcService {
  declare readonly _serviceBrand: undefined

  private readonly _client: ChannelClient
  private readonly _server: ChannelServer

  constructor(
    protocol: IMessagePassingProtocol,
    decodeInstrument?: (run: () => IpcMessage) => IpcMessage,
    codec: IpcCodec = defaultCodec,
  ) {
    super()
    const pair = this._register(new ChannelPair(protocol, decodeInstrument, codec))
    this._client = pair.client
    this._server = pair.server
  }

  getChannel(channelName: string): IChannel {
    return this._client.getChannel(channelName)
  }

  registerChannel(channelName: string, channel: IChannel): void {
    this._server.registerChannel(channelName, channel)
  }
}

export { toDisposable }
