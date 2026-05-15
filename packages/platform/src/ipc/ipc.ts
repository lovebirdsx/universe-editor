/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IPC framework (base/parts/ipc/common/ipc.ts).
 *  M1 scope: abstraction layer only. Electron adapter lives in apps/editor (M2).
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'

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
  error?: string
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

function encode(msg: IpcMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

function decode(data: Uint8Array): IpcMessage {
  return JSON.parse(new TextDecoder().decode(data)) as IpcMessage
}

/**
 * Client side: sends requests over a protocol and routes responses back to callers.
 * Also receives event messages and fires them on local Emitters.
 */
export class ChannelClient implements IChannelClient, IDisposable {
  private _requestId = 0
  private _disposed = false
  private readonly _pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly _eventEmitters = new Map<string, Emitter<unknown>>()
  private readonly _disposable: IDisposable

  constructor(private readonly _protocol: IMessagePassingProtocol) {
    this._disposable = _protocol.onMessage((data) => this._handleMessage(decode(data)))
  }

  private _handleMessage(msg: IpcMessage): void {
    if (msg.type === 'response') {
      const pending = this._pendingRequests.get(msg.id)
      if (pending) {
        this._pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error))
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

  dispose(): void {
    this._disposed = true
    this._disposable.dispose()
    this._pendingRequests.clear()
    for (const emitter of this._eventEmitters.values()) {
      emitter.dispose()
    }
    this._eventEmitters.clear()
  }
}

/**
 * Server side: receives requests, routes them to registered channels, sends responses.
 * Also allows channels to push events to the client.
 */
export class ChannelServer implements IChannelServer {
  private readonly _channels = new Map<string, IChannel>()
  private readonly _disposable: IDisposable
  private readonly _eventSubscriptions = new Map<string, IDisposable>()

  constructor(private readonly _protocol: IMessagePassingProtocol) {
    this._disposable = _protocol.onMessage((data) => this._handleMessage(decode(data)))
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
          error: `Channel '${channelName}' not found`,
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
        const error = err instanceof Error ? err.message : String(err)
        this._protocol.send(encode({ type: 'response', id, error }))
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

  dispose(): void {
    this._disposable.dispose()
    for (const sub of this._eventSubscriptions.values()) {
      sub.dispose()
    }
    this._eventSubscriptions.clear()
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

export class IpcService implements IIpcService, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _client: ChannelClient
  private readonly _server: ChannelServer

  constructor(protocol: IMessagePassingProtocol) {
    this._client = new ChannelClient(protocol)
    this._server = new ChannelServer(protocol)
  }

  getChannel(channelName: string): IChannel {
    return this._client.getChannel(channelName)
  }

  registerChannel(channelName: string, channel: IChannel): void {
    this._server.registerChannel(channelName, channel)
  }

  dispose(): void {
    this._client.dispose()
    this._server.dispose()
  }
}

export { toDisposable }
