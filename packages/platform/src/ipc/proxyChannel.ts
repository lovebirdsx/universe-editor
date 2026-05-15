/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's ProxyChannel (base/parts/ipc/common/ipc.ts).
 *
 *  Convention:
 *  - Property names matching /^on[A-Z]/ are treated as events: `channel.listen(name)`.
 *  - All other names are treated as methods: `channel.call(name, args)` where
 *    `args` is the spread arguments array (matches VSCode's wire format).
 *  - The `properties` option allows pre-resolved synchronous values (e.g. constants
 *    read from preload bridge) to be served from the proxy without IPC.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../base/event.js'
import { IChannel } from './ipc.js'

const EVENT_PROP_RE = /^on[A-Z]/

export interface IProxyServiceOptions {
  /**
   * Synchronous properties served locally instead of via the channel.
   * Useful for constants populated at bootstrap time (e.g. `platform`).
   * Keys take precedence over event / method dispatch.
   */
  readonly properties?: ReadonlyMap<string, unknown>
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ProxyChannel {
  /**
   * Wrap an IChannel as a typed service. Method calls become `channel.call`
   * with the spread arguments array; `onXxx` property reads become
   * `channel.listen` returning an Event<T>. Optional `properties` short-circuit
   * keys to local synchronous values.
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: IProxyServiceOptions,
  ): T {
    const cache = new Map<string, unknown>()
    return new Proxy(Object.create(null) as T, {
      get(_target, propKey) {
        if (typeof propKey !== 'string') {
          return undefined
        }
        const properties = options?.properties
        if (properties && properties.has(propKey)) {
          return properties.get(propKey)
        }
        const cached = cache.get(propKey)
        if (cached !== undefined) {
          return cached
        }
        if (EVENT_PROP_RE.test(propKey)) {
          const event = channel.listen(propKey)
          cache.set(propKey, event)
          return event
        }
        const fn = (...args: unknown[]): Promise<unknown> => channel.call(propKey, args)
        cache.set(propKey, fn)
        return fn
      },
    })
  }

  /**
   * Wrap a service instance as an IChannel: method names become `call` handlers
   * (invoked with the spread args), `Event<T>`-typed properties become `listen`
   * sources. Accepts both array and singleton call shapes for forward/backward
   * compatibility with older clients.
   */
  export function fromService<T extends object>(service: T): IChannel {
    const record = service as unknown as Record<string, unknown>
    return {
      call<R>(command: string, arg?: unknown): Promise<R> {
        const member = record[command]
        if (typeof member !== 'function') {
          return Promise.reject(new Error(`Method not found: ${command}`))
        }
        const args = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg]
        try {
          const result = (member as (...a: unknown[]) => unknown).apply(service, args)
          return Promise.resolve(result) as Promise<R>
        } catch (e) {
          return Promise.reject(e as Error)
        }
      },
      listen<E>(eventName: string): Event<E> {
        const member = record[eventName]
        if (typeof member === 'function') {
          // Events are accessor properties returning `Event<T>` (which is a function).
          return member as Event<E>
        }
        return Event.None
      },
    }
  }
}
