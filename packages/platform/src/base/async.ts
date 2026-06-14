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
