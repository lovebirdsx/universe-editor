/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IPC framework (base/parts/ipc/common/ipc.ts).
 *  M1 scope: abstraction layer only. Electron adapter lives in apps/editor (M2).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'
import { URI, type UriComponents } from '../base/uri.js'

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
  /** Optional: disconnect / close the transport. */
  disconnect?(): void
}

// -------- Channel abstraction --------

/**
 * A typed communication channel.
 * - `call` is request/response (returns a Promise).
 * - `listen` is push-based (returns an Event).
 */
export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>
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

type IpcMessage =
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | SubscribeMessage
  | UnsubscribeMessage

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
const U8_TAG = '$u8'
const B64_CHUNK = 0x8000

// URIs must survive the envelope as real `URI` instances, not bare
// `UriComponents`. `URI.toJSON()` already stamps `{ $mid: 1, scheme, ... }` when
// `JSON.stringify` walks a URI (so the replacer needs nothing), but the parse
// side would otherwise hand back a plain object with no `.fsPath`/`.with()` —
// forcing 50+ call sites to remember a manual `URI.revive`. The reviver rebuilds
// any `$mid: 1` object into a URI, killing that whole class of "forgot to revive"
// bugs. `URI.revive` is idempotent, so existing manual calls stay safe.
const URI_MID = 1

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
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

function encode(msg: IpcMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg, replacer))
}

function decode(data: Uint8Array): IpcMessage {
  return JSON.parse(new TextDecoder().decode(data), reviver) as IpcMessage
}

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

  constructor(private readonly _protocol: IMessagePassingProtocol) {
    super()
    this._register(_protocol.onMessage((data) => this._handleMessage(decode(data))))
  }

  private _handleMessage(msg: IpcMessage): void {
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
      call<T>(command: string, arg?: unknown): Promise<T> {
        const id = ++client._requestId
        return new Promise<T>((resolve, reject) => {
          client._pendingRequests.set(id, {
            resolve: (v) => resolve(v as T),
            reject,
          })
          client._protocol.send(encode({ type: 'request', id, channel: channelName, command, arg }))
        })
      },
      listen<T>(event: string, arg?: unknown): Event<T> {
        const key = `${channelName}:${event}`
        let emitter = client._eventEmitters.get(key)
        if (!emitter) {
          emitter = new Emitter<unknown>({
            onDidAddFirstListener: () => {
              client._protocol.send(encode({ type: 'subscribe', channel: channelName, event, arg }))
            },
            onDidRemoveLastListener: () => {
              if (client._disposed) {
                return
              }
              client._protocol.send(encode({ type: 'unsubscribe', channel: channelName, event }))
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

  constructor(private readonly _protocol: IMessagePassingProtocol) {
    super()
    this._register(_protocol.onMessage((data) => this._handleMessage(decode(data))))
  }

  registerChannel(channelName: string, channel: IChannel): void {
    this._channels.set(channelName, channel)
  }

  private _handleMessage(msg: IpcMessage): void {
    if (msg.type === 'request') {
      this._handleRequest(msg)
    } else if (msg.type === 'subscribe') {
      this._handleSubscribe(msg)
    } else if (msg.type === 'unsubscribe') {
      this._handleUnsubscribe(msg)
    }
  }

  private _handleRequest(msg: RequestMessage): void {
    const { id, channel: channelName, command, arg } = msg
    const channel = this._channels.get(channelName)

    if (!channel) {
      this._protocol.send(
        encode({
          type: 'response',
          id,
          error: { name: 'ChannelNotFoundError', message: `Channel '${channelName}' not found` },
        }),
      )
      return
    }

    channel
      .call(command, arg)
      .then((data) => {
        this._protocol.send(encode({ type: 'response', id, data }))
      })
      .catch((err: unknown) => {
        this._protocol.send(encode({ type: 'response', id, error: serializeError(err) }))
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
      this._protocol.send(encode({ type: 'event', channel: channelName, event, data }))
    })
    this._eventSubscriptions.set(key, sub)
  }

  private _handleUnsubscribe(msg: UnsubscribeMessage): void {
    const key = `${msg.channel}:${msg.event}`
    this._eventSubscriptions.get(key)?.dispose()
    this._eventSubscriptions.delete(key)
  }

  override dispose(): void {
    for (const sub of this._eventSubscriptions.values()) {
      sub.dispose()
    }
    this._eventSubscriptions.clear()
    super.dispose()
  }
}

/**
 * Helper: create a simple IChannel from a plain object of command handlers and events.
 */
export function createChannelFromObject(obj: {
  [command: string]: (...args: unknown[]) => unknown
}): IChannel {
  return {
    call<T>(command: string, arg?: unknown): Promise<T> {
      const handler = obj[command]
      if (typeof handler !== 'function') {
        return Promise.reject(new Error(`Unknown command: ${command}`))
      }
      try {
        return Promise.resolve(handler(arg) as T)
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

  constructor(protocol: IMessagePassingProtocol) {
    super()
    this._client = this._register(new ChannelClient(protocol))
    this._server = this._register(new ChannelServer(protocol))
  }

  getChannel(channelName: string): IChannel {
    return this._client.getChannel(channelName)
  }

  registerChannel(channelName: string, channel: IChannel): void {
    this._server.registerChannel(channelName, channel)
  }
}

export { toDisposable }
