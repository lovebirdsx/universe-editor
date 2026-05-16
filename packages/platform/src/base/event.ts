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

  /**
   * Debounce an event. Multiple `fire()`s within `delay` ms collapse into a
   * single output, computed by repeatedly calling `merge(last, current)`.
   *
   * @param leading                 fire immediately on the first event in a window
   * @param flushOnListenerRemove   flush pending output when a listener is removed
   *                                (useful when the listener owns the only reference)
   */
  export function debounce<I, O>(
    event: Event<I>,
    merge: (last: O | undefined, event: I) => O,
    delay: number = 100,
    leading: boolean = false,
    flushOnListenerRemove: boolean = false,
    disposable?: DisposableStore,
  ): Event<O> {
    let subscription: IDisposable | undefined
    let output: O | undefined = undefined
    let handle: ReturnType<typeof setTimeout> | undefined = undefined
    let numDebouncedCalls = 0
    let doFire: ((value: O | undefined) => void) | undefined

    const emitter = new Emitter<O>({
      onWillAddFirstListener() {
        subscription = event((cur) => {
          numDebouncedCalls++
          output = merge(output, cur)
          if (leading && handle === undefined) {
            emitter.fire(output)
            output = undefined
          }
          doFire = (value) => {
            const _output = value
            output = undefined
            handle = undefined
            if (!leading || numDebouncedCalls > 1) {
              emitter.fire(_output as O)
            }
            numDebouncedCalls = 0
          }
          if (handle !== undefined) {
            clearTimeout(handle)
          }
          handle = setTimeout(() => doFire?.(output), delay)
        })
      },
      onWillRemoveListener() {
        if (flushOnListenerRemove && numDebouncedCalls > 0) {
          doFire?.(output)
        }
      },
      onDidRemoveLastListener() {
        doFire = undefined
        subscription?.dispose()
        subscription = undefined
        if (handle !== undefined) {
          clearTimeout(handle)
          handle = undefined
        }
        output = undefined
        numDebouncedCalls = 0
      },
    })

    disposable?.add(emitter)
    return emitter.event
  }

  /**
   * Throttle an event. The first event in a window fires immediately (if
   * `leading`), subsequent events within `delay` ms are merged via `merge`
   * and emitted once at the window's end (if `trailing`).
   */
  export function throttle<I, O>(
    event: Event<I>,
    merge: (last: O | undefined, event: I) => O,
    delay: number = 100,
    leading: boolean = true,
    trailing: boolean = true,
    disposable?: DisposableStore,
  ): Event<O> {
    let subscription: IDisposable | undefined
    let pending: O | undefined = undefined
    let handle: ReturnType<typeof setTimeout> | undefined = undefined
    let inWindow = false

    const emitter = new Emitter<O>({
      onWillAddFirstListener() {
        subscription = event((cur) => {
          if (!inWindow) {
            inWindow = true
            if (leading) {
              emitter.fire(merge(undefined, cur))
            } else {
              pending = merge(pending, cur)
            }
            handle = setTimeout(() => {
              const out = pending
              pending = undefined
              handle = undefined
              inWindow = false
              if (trailing && out !== undefined) {
                emitter.fire(out)
              }
            }, delay)
          } else {
            pending = merge(pending, cur)
          }
        })
      },
      onDidRemoveLastListener() {
        if (handle !== undefined) {
          clearTimeout(handle)
          handle = undefined
        }
        inWindow = false
        pending = undefined
        subscription?.dispose()
        subscription = undefined
      },
    })

    disposable?.add(emitter)
    return emitter.event
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

export interface PauseableEmitterOptions<T> extends EmitterOptions {
  /**
   * If provided, events buffered while paused are collapsed into a single
   * event when resuming. Otherwise each buffered event is fired in order.
   */
  merge?: (input: T[]) => T
}

/**
 * Emitter that can be paused. While paused, `fire()` calls are queued; on
 * resume the queue is flushed (one-by-one, or via the `merge` option as a
 * single combined event). `pause()` calls nest — `resume()` only releases
 * the queue when the pause count returns to zero.
 */
export class PauseableEmitter<T> extends Emitter<T> {
  private _isPaused = 0
  protected _eventQueue = new LinkedList<T>()
  private readonly _mergeFn: ((input: T[]) => T) | undefined

  public get isPaused(): boolean {
    return this._isPaused !== 0
  }

  constructor(options?: PauseableEmitterOptions<T>) {
    super(options)
    this._mergeFn = options?.merge
  }

  pause(): void {
    this._isPaused++
  }

  resume(): void {
    if (this._isPaused !== 0 && --this._isPaused === 0) {
      if (this._mergeFn) {
        if (this._eventQueue.size > 0) {
          const events = Array.from(this._eventQueue)
          this._eventQueue.clear()
          super.fire(this._mergeFn(events))
        }
      } else {
        while (this._isPaused === 0 && this._eventQueue.size !== 0) {
          super.fire(this._eventQueue.shift() as T)
        }
      }
    }
  }

  override fire(event: T): void {
    if (this._isPaused !== 0) {
      this._eventQueue.push(event)
    } else {
      super.fire(event)
    }
  }
}

/**
 * Relays events from a swappable input event to a single output event. When
 * the relay has no listeners, no subscription is held on the input — this
 * keeps the upstream emitter quiet and avoids leaks. Assign a new event to
 * `input` at any time; the active subscription transfers automatically.
 */
export class Relay<T> implements IDisposable {
  private listening = false
  private inputEvent: Event<T> = Event.None
  private inputEventListener: IDisposable = Disposable.None

  private readonly emitter = new Emitter<T>({
    onDidAddFirstListener: () => {
      this.listening = true
      this.inputEventListener = this.inputEvent(this.emitter.fire, this.emitter)
    },
    onDidRemoveLastListener: () => {
      this.listening = false
      this.inputEventListener.dispose()
    },
  })

  public readonly event: Event<T> = this.emitter.event

  set input(event: Event<T>) {
    this.inputEvent = event
    if (this.listening) {
      this.inputEventListener.dispose()
      this.inputEventListener = event(this.emitter.fire, this.emitter)
    }
  }

  dispose(): void {
    this.inputEventListener.dispose()
    this.emitter.dispose()
  }
}
