/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/lifecycle.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * An object that performs a cleanup operation when `.dispose()` is called.
 */
export interface IDisposable {
  dispose(): void
}

/**
 * Check if `thing` is {@link IDisposable disposable}.
 */
export function isDisposable<E>(thing: E): thing is E & IDisposable {
  return (
    typeof thing === 'object' &&
    thing !== null &&
    typeof (thing as unknown as IDisposable).dispose === 'function' &&
    (thing as unknown as IDisposable).dispose.length === 0
  )
}

function isIterable<T>(arg: unknown): arg is Iterable<T> {
  return !!arg && typeof (arg as Record<symbol, unknown>)[Symbol.iterator] === 'function'
}

/**
 * Disposes of the value(s) passed in.
 */
export function dispose<T extends IDisposable>(disposable: T): T
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined
export function dispose<T extends IDisposable, A extends Iterable<T> = Iterable<T>>(
  disposables: A,
): A
export function dispose<T extends IDisposable>(disposables: Array<T>): Array<T>
export function dispose<T extends IDisposable>(disposables: ReadonlyArray<T>): ReadonlyArray<T>
export function dispose<T extends IDisposable>(arg: T | Iterable<T> | undefined): unknown {
  if (isIterable<T>(arg)) {
    const errors: unknown[] = []
    for (const d of arg) {
      if (d) {
        try {
          d.dispose()
        } catch (e) {
          errors.push(e)
        }
      }
    }
    if (errors.length === 1) {
      throw errors[0]
    } else if (errors.length > 1) {
      throw new AggregateError(errors, 'Encountered errors while disposing of store')
    }
    return Array.isArray(arg) ? [] : arg
  } else if (arg) {
    arg.dispose()
    return arg
  }
  return undefined
}

/**
 * Combine multiple disposable values into a single {@link IDisposable}.
 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  return toDisposable(() => dispose(disposables))
}

/**
 * Turn a function that implements dispose into an {@link IDisposable}.
 *
 * @param fn Clean up function, guaranteed to be called only **once**.
 */
export function toDisposable(fn: () => void): IDisposable {
  let disposed = false
  return {
    dispose() {
      if (!disposed) {
        disposed = true
        fn()
      }
    },
  }
}

/**
 * Indicates that the given object is a singleton which does not need to be disposed.
 * No-op in this simplified implementation.
 */
export function markAsSingleton<T extends IDisposable>(singleton: T): T {
  return singleton
}

/**
 * Manages a collection of disposable values.
 */
export class DisposableStore implements IDisposable {
  static DISABLE_DISPOSED_WARNING = false

  private readonly _toDispose = new Set<IDisposable>()
  private _isDisposed = false

  /**
   * Dispose of all registered disposables and mark this object as disposed.
   */
  public dispose(): void {
    if (this._isDisposed) {
      return
    }
    this._isDisposed = true
    this.clear()
  }

  public get isDisposed(): boolean {
    return this._isDisposed
  }

  /**
   * Dispose of all registered disposables but do not mark this object as disposed.
   */
  public clear(): void {
    if (this._toDispose.size === 0) {
      return
    }
    try {
      dispose(this._toDispose)
    } finally {
      this._toDispose.clear()
    }
  }

  /**
   * Add a new {@link IDisposable disposable} to the collection.
   */
  public add<T extends IDisposable>(o: T): T {
    if (!o || o === (Disposable.None as unknown as T)) {
      return o
    }
    if ((o as unknown as DisposableStore) === this) {
      throw new Error('Cannot register a disposable on itself!')
    }
    if (this._isDisposed) {
      if (!DisposableStore.DISABLE_DISPOSED_WARNING) {
        console.warn(
          new Error(
            'Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!',
          ).stack,
        )
      }
    } else {
      this._toDispose.add(o)
    }
    return o
  }

  /**
   * Deletes a disposable from store and disposes of it.
   */
  public delete<T extends IDisposable>(o: T): void {
    if (!o) {
      return
    }
    if ((o as unknown as DisposableStore) === this) {
      throw new Error('Cannot dispose a disposable on itself!')
    }
    this._toDispose.delete(o)
    o.dispose()
  }

  /**
   * Deletes the value from the store, but does not dispose it.
   */
  public deleteAndLeak<T extends IDisposable>(o: T): void {
    if (!o) {
      return
    }
    this._toDispose.delete(o)
  }
}

/**
 * Abstract base class for a {@link IDisposable disposable} object.
 */
export abstract class Disposable implements IDisposable {
  static readonly None = Object.freeze<IDisposable>({ dispose() {} })

  protected readonly _store = new DisposableStore()

  public dispose(): void {
    this._store.dispose()
  }

  protected _register<T extends IDisposable>(o: T): T {
    if ((o as unknown as Disposable) === this) {
      throw new Error('Cannot register a disposable on itself!')
    }
    return this._store.add(o)
  }
}

/**
 * Manages the lifecycle of a disposable value that may be changed.
 *
 * Ensures that when the value is changed, the previously held disposable is disposed of.
 */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  private _value: T | undefined
  private _isDisposed = false

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value
  }

  set value(value: T | undefined) {
    if (this._isDisposed || value === this._value) {
      return
    }
    this._value?.dispose()
    this._value = value
  }

  clear(): void {
    this.value = undefined
  }

  dispose(): void {
    this._isDisposed = true
    this._value?.dispose()
    this._value = undefined
  }

  /**
   * Clears the value without disposing it. The caller takes ownership.
   */
  clearAndLeak(): T | undefined {
    const oldValue = this._value
    this._value = undefined
    return oldValue
  }
}
