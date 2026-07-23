/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/async.ts
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from './errors.js'
import { IDisposable, setParentOfDisposable, toDisposable } from './lifecycle.js'

export interface IdleDeadline {
  readonly didTimeout: boolean
  timeRemaining(): number
}

interface IdleApi {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    opts?: { timeout: number },
  ) => number
  cancelIdleCallback?: (handle: number) => void
}

/**
 * Run `callback` when the host is idle. Falls back to `setTimeout(0)` with a
 * synthetic deadline when `requestIdleCallback` is unavailable (Node, jsdom,
 * happy-dom). The returned disposable cancels the pending callback.
 */
export function runWhenIdle(
  target: IdleApi | undefined,
  callback: (deadline: IdleDeadline) => void,
  timeout?: number,
): IDisposable {
  if (target && typeof target.requestIdleCallback === 'function') {
    const handle = target.requestIdleCallback(
      callback,
      typeof timeout === 'number' ? { timeout } : undefined,
    )
    const cancel = target.cancelIdleCallback
    return toDisposable(() => {
      if (typeof cancel === 'function') {
        cancel(handle)
      }
    })
  }

  const start = Date.now()
  const handle = setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining() {
        return Math.max(0, 15 - (Date.now() - start))
      },
    })
  }, 0)
  return toDisposable(() => clearTimeout(handle))
}

/**
 * Value computed once at idle time. Reading {@link value} before the idle
 * callback fires forces synchronous computation (and cancels the pending
 * callback) — guaranteeing the value is always available on demand.
 */
export class AbstractIdleValue<T> implements IDisposable {
  private readonly _executor: () => void
  private readonly _handle: IDisposable
  private _didRun = false
  private _value: T | undefined
  private _error: unknown

  constructor(target: IdleApi | undefined, executor: () => T) {
    this._executor = () => {
      try {
        this._value = executor()
      } catch (err) {
        this._error = err
      } finally {
        this._didRun = true
      }
    }
    this._handle = runWhenIdle(target, () => this._executor())
    // The idle handle is an internal detail of this value; parent it here so leak
    // detection roots it under this object (and excludes it when this value is
    // marked as a singleton, e.g. lazy DI service materialization).
    setParentOfDisposable(this._handle, this)
  }

  dispose(): void {
    this._handle.dispose()
  }

  get value(): T {
    if (!this._didRun) {
      this._handle.dispose()
      this._executor()
    }
    if (this._error !== undefined) {
      throw this._error
    }
    return this._value as T
  }

  get isInitialized(): boolean {
    return this._didRun
  }
}

/**
 * Idle-computed value bound to `globalThis` (uses `globalThis.requestIdleCallback`
 * when available; falls back to a timer otherwise).
 */
export class GlobalIdleValue<T> extends AbstractIdleValue<T> {
  constructor(executor: () => T) {
    super(globalThis as IdleApi, executor)
  }
}

/**
 * A promise whose resolution is controlled from the outside, exposing
 * `complete` / `error` / `cancel` plus the settled state. Mirrors VSCode's
 * `DeferredPromise` (base/common/async.ts) — used wherever a producer must
 * settle a promise that was handed to a separate consumer (e.g. the renderer
 * AI client resolving `result` once the main process signals end-of-stream).
 */
export class DeferredPromise<T> {
  private _completeCallback!: (value: T) => void
  private _errorCallback!: (err: unknown) => void
  private _state: 'idle' | 'resolved' | 'rejected' = 'idle'

  readonly p: Promise<T>

  constructor() {
    this.p = new Promise<T>((resolve, reject) => {
      this._completeCallback = resolve
      this._errorCallback = reject
    })
  }

  get isSettled(): boolean {
    return this._state !== 'idle'
  }

  get isResolved(): boolean {
    return this._state === 'resolved'
  }

  get isRejected(): boolean {
    return this._state === 'rejected'
  }

  complete(value: T): void {
    if (this._state !== 'idle') return
    this._state = 'resolved'
    this._completeCallback(value)
  }

  error(err: unknown): void {
    if (this._state !== 'idle') return
    this._state = 'rejected'
    this._errorCallback(err)
  }

  cancel(): void {
    this.error(new CancellationError())
  }
}

/**
 * The read side of an {@link AsyncIterableSource}: uses the global
 * `AsyncIterable<T>` so consumers can `for await` over it directly.
 */
interface IQueueItem<T> {
  readonly value?: T
  readonly done: boolean
  readonly error?: unknown
}

/**
 * Push-driven `AsyncIterable`: a producer calls `emitOne` for each value and
 * `resolve` / `reject` to terminate; a single consumer drives the resulting
 * `asyncIterable`. This is the receiving-end reassembly primitive for streams
 * that cross a boundary as discrete events (mirrors VSCode's
 * `AsyncIterableSource`, used in `extHostLanguageModels.ts` to rebuild a chat
 * response stream from individual RPC chunks).
 *
 * Single-consumer only: the async iterator is created lazily on first
 * iteration and a second iteration throws.
 */
export class AsyncIterableSource<T> {
  private readonly _queue: IQueueItem<T>[] = []
  private _onStateChanged: (() => void) | undefined
  private _consumed = false
  private _closed = false

  /** Push the next value to the consumer. No-op once resolved/rejected. */
  emitOne(value: T): void {
    if (this._closed) return
    this._queue.push({ value, done: false })
    this._onStateChanged?.()
  }

  /** Signal successful end-of-stream. Subsequent emits are ignored. */
  resolve(): void {
    if (this._closed) return
    this._closed = true
    this._queue.push({ done: true })
    this._onStateChanged?.()
  }

  /** Signal failure; the consumer's iteration rejects with `error`. */
  reject(error: unknown): void {
    if (this._closed) return
    this._closed = true
    this._queue.push({ done: true, error })
    this._onStateChanged?.()
  }

  get asyncIterable(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => this._createIterator(),
    }
  }

  private _createIterator(): AsyncIterator<T> {
    if (this._consumed) {
      throw new Error('AsyncIterableSource can only be consumed once')
    }
    this._consumed = true

    const next = (): Promise<IteratorResult<T>> => {
      const item = this._queue.shift()
      if (item) {
        if (item.error !== undefined) return Promise.reject(item.error)
        if (item.done) return Promise.resolve({ done: true, value: undefined })
        return Promise.resolve({ done: false, value: item.value as T })
      }
      // Nothing buffered yet — wait for the next state change, then retry.
      return new Promise<void>((resolve) => {
        this._onStateChanged = (): void => {
          this._onStateChanged = undefined
          resolve()
        }
      }).then(next)
    }

    return { next }
  }
}

/**
 * A helper to prevent accumulation of sequential async tasks: while a task is
 * running, incoming factories coalesce into a single queued run that starts
 * when the active one settles (VSCode's Throttler).
 */
export class Throttler implements IDisposable {
  private _activePromise: Promise<unknown> | undefined
  private _queuedPromise: Promise<unknown> | undefined
  private _queuedPromiseFactory: (() => Promise<unknown>) | undefined
  private _isDisposed = false

  queue<T>(promiseFactory: () => Promise<T>): Promise<T> {
    if (this._isDisposed) {
      return Promise.reject(new Error('Throttler is disposed'))
    }

    if (this._activePromise) {
      this._queuedPromiseFactory = promiseFactory
      if (!this._queuedPromise) {
        const onComplete = (): Promise<unknown> | undefined => {
          this._queuedPromise = undefined
          if (this._isDisposed) return undefined
          const factory = this._queuedPromiseFactory!
          this._queuedPromiseFactory = undefined
          return this.queue(factory)
        }
        this._queuedPromise = new Promise((resolve) => {
          this._activePromise!.then(onComplete, onComplete).then(resolve)
        })
      }
      return new Promise((resolve, reject) => {
        this._queuedPromise!.then(resolve as (value: unknown) => void, reject)
      })
    }

    this._activePromise = promiseFactory()
    return new Promise((resolve, reject) => {
      this._activePromise!.then(
        (result) => {
          this._activePromise = undefined
          resolve(result as T)
        },
        (err: unknown) => {
          this._activePromise = undefined
          reject(err as Error)
        },
      )
    })
  }

  dispose(): void {
    this._isDisposed = true
  }
}

/**
 * Trailing-edge debounce for async tasks: each `trigger` postpones execution by
 * `delay`; only the latest task runs once the timer fires (VSCode's Delayer).
 * A superseded or cancelled trigger's promise rejects with CancellationError.
 */
export class Delayer<T> implements IDisposable {
  private _timeout: ReturnType<typeof setTimeout> | undefined
  private _completionPromise: Promise<T> | undefined
  private _doResolve: (() => void) | undefined
  private _doReject: ((err: unknown) => void) | undefined
  private _task: (() => T | Promise<T>) | undefined

  constructor(public defaultDelay: number) {}

  trigger(task: () => T | Promise<T>, delay = this.defaultDelay): Promise<T> {
    this._task = task
    this._cancelTimeout()

    if (!this._completionPromise) {
      this._completionPromise = new Promise<void>((resolve, reject) => {
        this._doResolve = resolve
        this._doReject = reject
      }).then(() => {
        this._completionPromise = undefined
        this._doResolve = undefined
        const currentTask = this._task!
        this._task = undefined
        return currentTask()
      })
    }

    this._timeout = setTimeout(() => {
      this._timeout = undefined
      this._doResolve?.()
    }, delay)

    return this._completionPromise
  }

  isTriggered(): boolean {
    return this._timeout !== undefined
  }

  cancel(): void {
    this._cancelTimeout()
    if (this._completionPromise) {
      this._doReject?.(new CancellationError())
      this._completionPromise = undefined
    }
  }

  private _cancelTimeout(): void {
    if (this._timeout !== undefined) {
      clearTimeout(this._timeout)
      this._timeout = undefined
    }
  }

  dispose(): void {
    this.cancel()
  }
}

/**
 * Delayer + Throttler (VSCode's ThrottledDelayer): triggers debounce by
 * `delay`, and a task that is still running when the next timer fires delays
 * the queued run until it settles — long tasks never overlap and never pile up.
 * VSCode's dirty-diff model drives its per-keystroke re-diff through exactly
 * this (200ms).
 */
export class ThrottledDelayer<T> implements IDisposable {
  private readonly _delayer: Delayer<Promise<T>>
  private readonly _throttler = new Throttler()

  constructor(defaultDelay: number) {
    this._delayer = new Delayer(defaultDelay)
  }

  trigger(promiseFactory: () => Promise<T>, delay?: number): Promise<T> {
    return this._delayer.trigger(
      () => this._throttler.queue(promiseFactory),
      delay,
    ) as unknown as Promise<T>
  }

  isTriggered(): boolean {
    return this._delayer.isTriggered()
  }

  cancel(): void {
    this._delayer.cancel()
  }

  dispose(): void {
    this._delayer.dispose()
    this._throttler.dispose()
  }
}
