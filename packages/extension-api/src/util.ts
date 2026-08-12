/**
 * Self-contained utility primitives of the API surface (the `vscode` module's
 * `Disposable` / `EventEmitter` / `CancellationTokenSource` counterparts). These
 * run entirely inside the extension host — no RPC, no host bridge.
 */

/** A subscribable signal: call with a listener, dispose to unsubscribe. */
export type Event<T> = (listener: (e: T) => void) => Disposable

// The callback lives in a WeakMap rather than a private field: a private member
// would end the structural compatibility with plain `{ dispose() {...} }` object
// literals that the whole API surface relies on.
const disposeCallbacks = new WeakMap<Disposable, () => void>()

/**
 * A disposable resource. Dispose is idempotent — the callback runs on the first
 * call only. Anything with a `dispose(): void` method structurally satisfies
 * this class, so object literals keep working wherever a Disposable is expected.
 */
export class Disposable {
  /** `callOnDispose` runs on the first {@link dispose} call; later calls no-op. */
  constructor(callOnDispose: () => void) {
    disposeCallbacks.set(this, callOnDispose)
  }

  dispose(): void {
    const callback = disposeCallbacks.get(this)
    if (callback) {
      disposeCallbacks.delete(this)
      callback()
    }
  }

  /** Combine several disposable-likes into one that disposes them all in order. */
  static from(...disposableLikes: { dispose: () => unknown }[]): Disposable {
    return new Disposable(() => {
      for (const disposable of disposableLikes) {
        disposable.dispose()
      }
    })
  }
}

/**
 * An event source an extension owns: listeners subscribe via {@link event},
 * {@link fire} delivers to every subscribed listener. A throwing listener is
 * reported via `console.error` and does not prevent delivery to the rest.
 * After {@link dispose}, `fire` is a no-op.
 */
export class EventEmitter<T> {
  private _listeners: Set<(e: T) => void> | undefined = new Set()

  readonly event: Event<T> = (listener) => {
    const listeners = this._listeners
    if (!listeners) return new Disposable(() => undefined)
    listeners.add(listener)
    return new Disposable(() => {
      listeners.delete(listener)
    })
  }

  fire(data: T): void {
    const listeners = this._listeners
    if (!listeners) return
    // Snapshot: a listener may subscribe or dispose during delivery.
    for (const listener of [...listeners]) {
      try {
        listener(data)
      } catch (err) {
        console.error(err)
      }
    }
  }

  dispose(): void {
    this._listeners?.clear()
    this._listeners = undefined
  }
}

/** Cooperative cancellation for long-running provider requests. */
export interface CancellationToken {
  readonly isCancellationRequested: boolean
  /** Fires once when cancellation is requested. Fires immediately if already cancelled. */
  onCancellationRequested(listener: () => void): Disposable
}

/** The token a {@link CancellationTokenSource} hands out; the source drives it. */
class MutableToken implements CancellationToken {
  cancelled = false
  readonly listeners = new Set<() => void>()

  get isCancellationRequested(): boolean {
    return this.cancelled
  }

  onCancellationRequested(listener: () => void): Disposable {
    if (this.cancelled) {
      // The token contract: an already-cancelled token fires immediately.
      try {
        listener()
      } catch (err) {
        console.error(err)
      }
      return new Disposable(() => undefined)
    }
    this.listeners.add(listener)
    return new Disposable(() => {
      this.listeners.delete(listener)
    })
  }
}

/**
 * Owns a {@link CancellationToken} and signals cancellation through it.
 * `cancel()` is idempotent and fires every registered listener once; listeners
 * registered after cancellation fire immediately. `dispose()` releases the
 * listener registrations without cancelling.
 */
export class CancellationTokenSource {
  private readonly _token = new MutableToken()

  get token(): CancellationToken {
    return this._token
  }

  cancel(): void {
    const token = this._token
    if (token.cancelled) return
    token.cancelled = true
    const listeners = [...token.listeners]
    token.listeners.clear()
    for (const listener of listeners) {
      try {
        listener()
      } catch (err) {
        console.error(err)
      }
    }
  }

  dispose(): void {
    this._token.listeners.clear()
  }
}
