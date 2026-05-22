/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CancellationToken / CancellationTokenSource — VSCode parity.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from './event.js'
import type { IDisposable } from './lifecycle.js'

export interface CancellationToken {
  readonly isCancellationRequested: boolean
  /** Fires once when cancellation is requested. Fires immediately if already cancelled. */
  readonly onCancellationRequested: Event<void>
}

const shortcutEvent: Event<void> = Object.freeze((callback, thisArgs) => {
  const handle = setTimeout(callback.bind(thisArgs), 0)
  return {
    dispose(): void {
      clearTimeout(handle)
    },
  }
}) as Event<void>

const _none: CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: ((): IDisposable => ({ dispose(): void {} })) as Event<void>,
})

const _cancelled: CancellationToken = Object.freeze({
  isCancellationRequested: true,
  onCancellationRequested: shortcutEvent,
})

function isCancellationToken(thing: unknown): thing is CancellationToken {
  if (thing === _none || thing === _cancelled) return true
  if (thing === null || typeof thing !== 'object') return false
  const obj = thing as Partial<CancellationToken>
  return (
    typeof obj.isCancellationRequested === 'boolean' &&
    typeof obj.onCancellationRequested === 'function'
  )
}

export const CancellationToken: {
  readonly None: CancellationToken
  readonly Cancelled: CancellationToken
  isCancellationToken(thing: unknown): thing is CancellationToken
} = Object.freeze({
  None: _none,
  Cancelled: _cancelled,
  isCancellationToken,
})

class MutableToken implements CancellationToken {
  private _isCancelled = false
  private _emitter: Emitter<void> | null = null

  cancel(): void {
    if (this._isCancelled) return
    this._isCancelled = true
    if (this._emitter !== null) {
      this._emitter.fire()
      this._emitter.dispose()
      this._emitter = null
    }
  }

  get isCancellationRequested(): boolean {
    return this._isCancelled
  }

  get onCancellationRequested(): Event<void> {
    if (this._isCancelled) return shortcutEvent
    if (this._emitter === null) this._emitter = new Emitter<void>()
    return this._emitter.event
  }

  dispose(): void {
    if (this._emitter !== null) {
      this._emitter.dispose()
      this._emitter = null
    }
  }
}

export class CancellationTokenSource implements IDisposable {
  private _token: CancellationToken | undefined
  private readonly _parentListener: IDisposable | undefined

  constructor(parent?: CancellationToken) {
    if (parent !== undefined) {
      this._parentListener = parent.onCancellationRequested(() => {
        this.cancel()
      })
    }
  }

  get token(): CancellationToken {
    if (this._token === undefined) this._token = new MutableToken()
    return this._token
  }

  cancel(): void {
    if (this._token === undefined) {
      this._token = CancellationToken.Cancelled
    } else if (this._token instanceof MutableToken) {
      this._token.cancel()
    }
  }

  dispose(cancel = false): void {
    if (cancel) this.cancel()
    this._parentListener?.dispose()
    if (this._token === undefined) {
      this._token = CancellationToken.None
    } else if (this._token instanceof MutableToken) {
      this._token.dispose()
    }
  }
}
