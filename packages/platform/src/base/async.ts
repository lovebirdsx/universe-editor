/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/async.ts
 *--------------------------------------------------------------------------------------------*/

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
