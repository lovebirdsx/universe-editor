/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/event.ts
 *--------------------------------------------------------------------------------------------*/

import {
  combinedDisposable,
  Disposable,
  DisposableStore,
  IDisposable,
  toDisposable,
} from './lifecycle.js'
import { LinkedList } from './linkedList.js'

/**
 * An event with zero or one parameters that can be subscribed to. The event is a function itself.
 */
export interface Event<T> {
  (
    listener: (e: T) => unknown,
    thisArgs?: unknown,
    disposables?: IDisposable[] | DisposableStore,
  ): IDisposable
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Event {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const None: Event<any> = () => Disposable.None

  /**
   * Given an event, returns another event which only fires once.
   */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener, thisArgs?, disposables?) => {
      let didFire = false
      let result: IDisposable | undefined = undefined
      result = event(
        (e) => {
          if (didFire) {
            return
          } else if (result) {
            result.dispose()
          } else {
            didFire = true
          }
          return listener.call(thisArgs, e)
        },
        null,
        disposables,
      )

      if (didFire) {
        result.dispose()
      }

      return result
    }
  }

  /**
   * Maps an event of one type into an event of another type using a mapping function.
   */
  export function map<I, O>(event: Event<I>, mapFn: (i: I) => O): Event<O> {
    return (listener, thisArgs?, disposables?) =>
      event((i) => listener.call(thisArgs, mapFn(i)), null, disposables)
  }

  /**
   * Wraps an event in another event that fires only when the condition is met.
   */
  export function filter<T, U>(event: Event<T | U>, filterFn: (e: T | U) => e is T): Event<T>
  export function filter<T>(event: Event<T>, filterFn: (e: T) => boolean): Event<T>
  export function filter<T>(event: Event<T>, filterFn: (e: T) => boolean): Event<T> {
    return (listener, thisArgs?, disposables?) =>
      event((e) => filterFn(e) && (listener.call(thisArgs, e) as unknown), null, disposables)
  }

  /**
   * Given a collection of events, returns a single event which emits whenever any of the provided events emit.
   */
  export function any<T>(...events: Event<T>[]): Event<T>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function any(...events: Event<any>[]): Event<void>
  export function any<T>(...events: Event<T>[]): Event<T> {
    return (listener, thisArgs?, disposables?) => {
      const d = combinedDisposable(
        ...events.map((event) => event((e) => listener.call(thisArgs, e))),
      )
      if (disposables instanceof DisposableStore) {
        disposables.add(d)
      } else if (Array.isArray(disposables)) {
        disposables.push(d)
      }
      return d
    }
  }

  /**
   * Creates a Promise that resolves the next time the event fires.
   */
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve))
  }
}

export interface EmitterOptions {
  /** Called before the very first listener is added. */
  onWillAddFirstListener?: () => void
  /** Called after the very first listener is added. */
  onDidAddFirstListener?: () => void
  /** Called after each listener is added. */
  onDidAddListener?: () => void
  /** Called before a listener is removed. */
  onWillRemoveListener?: () => void
  /** Called after the last listener is removed. */
  onDidRemoveLastListener?: () => void
  /** Called when a listener throws an error. Defaults to console.error. */
  onListenerError?: (e: unknown) => void
}

/**
 * The Emitter can be used to expose an Event to the public to fire it from the insides.
 *
 * @example
 * class Document {
 *   private readonly _onDidChange = new Emitter<string>();
 *   public readonly onDidChange = this._onDidChange.event;
 *
 *   private _doIt() {
 *     this._onDidChange.fire(value);
 *   }
 * }
 */
export class Emitter<T> {
  private readonly _options: EmitterOptions | undefined
  private _disposed = false
  private _event?: Event<T>
  private readonly _listeners = new LinkedList<(e: T) => void>()

  constructor(options?: EmitterOptions) {
    this._options = options
  }

  /**
   * For the public to allow subscribing to events from this Emitter.
   */
  get event(): Event<T> {
    this._event ??= (
      callback: (e: T) => unknown,
      thisArgs?: unknown,
      disposables?: IDisposable[] | DisposableStore,
    ) => {
      if (this._disposed) {
        return Disposable.None
      }

      const fn = thisArgs
        ? ((callback as (e: T) => unknown).bind(thisArgs) as (e: T) => unknown)
        : callback

      const isFirst = this._listeners.size === 0
      if (isFirst) {
        this._options?.onWillAddFirstListener?.()
      }

      const remove = this._listeners.push(fn)

      if (isFirst) {
        this._options?.onDidAddFirstListener?.()
      }
      this._options?.onDidAddListener?.()

      const result = toDisposable(() => {
        this._options?.onWillRemoveListener?.()
        remove()
        if (this._listeners.size === 0) {
          this._options?.onDidRemoveLastListener?.()
        }
      })

      if (disposables instanceof DisposableStore) {
        disposables.add(result)
      } else if (Array.isArray(disposables)) {
        disposables.push(result)
      }

      return result
    }

    return this._event
  }

  /**
   * To be kept private to fire an event to subscribers.
   */
  fire(event: T): void {
    if (this._disposed || this._listeners.size === 0) {
      return
    }

    // Snapshot listeners to handle re-entrant fire() calls safely
    const listeners = [...this._listeners]
    const errorHandler = this._options?.onListenerError ?? ((e: unknown) => console.error(e))

    for (const listener of listeners) {
      try {
        listener(event)
      } catch (e) {
        errorHandler(e)
      }
    }
  }

  dispose(): void {
    if (!this._disposed) {
      this._disposed = true
      const hadListeners = this._listeners.size > 0
      this._listeners.clear()
      if (hadListeners) {
        this._options?.onDidRemoveLastListener?.()
      }
    }
  }
}
