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

// ---------------------------------------------------------------------------
// Disposable leak tracking
// ---------------------------------------------------------------------------

/**
 * Hook for instrumenting the disposable lifecycle. Implementations receive
 * notifications at construction, parent attachment, disposal, and singleton
 * marking — allowing dev/test tooling to detect leaked disposables.
 *
 * No tracker is installed by default; production code pays zero cost.
 */
export interface IDisposableTracker {
  /** Called when a disposable is created. */
  trackDisposable(disposable: IDisposable): void
  /** Called when a disposable becomes (or stops being) a child of another. */
  setParent(child: IDisposable, parent: IDisposable | null): void
  /** Called after `dispose()` runs on a tracked disposable. */
  markAsDisposed(disposable: IDisposable): void
  /** Called to mark a disposable as a singleton that need not be released. */
  markAsSingleton(disposable: IDisposable): void
}

let disposableTracker: IDisposableTracker | null = null

/**
 * Install (or clear) the global disposable tracker. Pass `null` to disable.
 *
 * Recommended use: in dev mode set `new DisposableTracker()` early in
 * bootstrap; in tests wrap blocks with the `withLeakCheck` helper.
 */
export function setDisposableTracker(tracker: IDisposableTracker | null): void {
  disposableTracker = tracker
}

/** Returns the active tracker, or `null` if none installed. */
export function getDisposableTracker(): IDisposableTracker | null {
  return disposableTracker
}

function trackDisposable<T extends IDisposable>(x: T): T {
  disposableTracker?.trackDisposable(x)
  return x
}

function setParentOfDisposable(child: IDisposable, parent: IDisposable | null): void {
  disposableTracker?.setParent(child, parent)
}

function markAsDisposed(x: IDisposable): void {
  disposableTracker?.markAsDisposed(x)
}

interface DisposableInfo {
  source: string | null
  parent: IDisposable | null
  isSingleton: boolean
  value: IDisposable
  idx: number
}

/**
 * Heavyweight tracker for dev/test use. Records a stack trace at construction
 * and lets you query for disposables that were never released.
 */
export class DisposableTracker implements IDisposableTracker {
  private static idx = 0
  private readonly livingDisposables = new Map<IDisposable, DisposableInfo>()

  private getDisposableData(d: IDisposable): DisposableInfo {
    let result = this.livingDisposables.get(d)
    if (!result) {
      result = {
        parent: null,
        source: null,
        isSingleton: false,
        value: d,
        idx: DisposableTracker.idx++,
      }
      this.livingDisposables.set(d, result)
    }
    return result
  }

  trackDisposable(d: IDisposable): void {
    const data = this.getDisposableData(d)
    if (!data.source) {
      data.source = new Error().stack ?? null
    }
  }

  setParent(child: IDisposable, parent: IDisposable | null): void {
    this.getDisposableData(child).parent = parent
  }

  markAsDisposed(x: IDisposable): void {
    this.livingDisposables.delete(x)
  }

  markAsSingleton(d: IDisposable): void {
    this.getDisposableData(d).isSingleton = true
  }

  /**
   * Compute the set of disposables that were tracked, are still alive, and
   * are not rooted under a singleton. Returns `undefined` when clean.
   */
  computeLeakingDisposables(
    maxReported = 10,
  ): { leaks: DisposableInfo[]; details: string } | undefined {
    const rootCache = new Map<DisposableInfo, DisposableInfo>()
    const resolveRoot = (info: DisposableInfo): DisposableInfo => {
      const cached = rootCache.get(info)
      if (cached) return cached
      const visited = new Set<DisposableInfo>()
      let cur = info
      while (cur.parent && !visited.has(cur)) {
        visited.add(cur)
        const parentInfo = this.livingDisposables.get(cur.parent)
        if (!parentInfo) break
        cur = parentInfo
      }
      rootCache.set(info, cur)
      return cur
    }

    const leaks = [...this.livingDisposables.values()].filter(
      (info) => info.source !== null && !resolveRoot(info).isSingleton,
    )
    if (leaks.length === 0) return undefined

    const sample = leaks.slice(0, maxReported)
    const details = sample
      .map((info, i) => `[Leak #${i + 1}] idx=${info.idx}\n${info.source ?? '(no source)'}`)
      .join('\n\n')
    return { leaks, details }
  }
}

/**
 * Lightweight tracker that uses `FinalizationRegistry` to warn when a tracked
 * disposable is garbage-collected without first being disposed. Suitable for
 * always-on use, but only catches leaks observable to the GC (slower feedback
 * than {@link DisposableTracker}).
 */
export class GCBasedDisposableTracker implements IDisposableTracker {
  private readonly _registry = new FinalizationRegistry<string>((heldValue) => {
    console.warn(`[LEAKED DISPOSABLE]\n${heldValue}`)
  })

  trackDisposable(disposable: IDisposable): void {
    const stack = new Error('CREATED via:').stack ?? ''
    this._registry.register(disposable, stack, disposable)
  }

  setParent(_child: IDisposable, _parent: IDisposable | null): void {
    // no-op
  }

  markAsDisposed(disposable: IDisposable): void {
    this._registry.unregister(disposable)
  }

  markAsSingleton(disposable: IDisposable): void {
    this._registry.unregister(disposable)
  }
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

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
  const parent = toDisposable(() => dispose(disposables))
  for (const child of disposables) {
    setParentOfDisposable(child, parent)
  }
  return parent
}

/**
 * Turn a function that implements dispose into an {@link IDisposable}.
 *
 * @param fn Clean up function, guaranteed to be called only **once**.
 */
export function toDisposable(fn: () => void): IDisposable {
  let disposed = false
  const self: IDisposable = trackDisposable({
    dispose() {
      if (!disposed) {
        disposed = true
        markAsDisposed(self)
        fn()
      }
    },
  })
  return self
}

/**
 * Mark a disposable as a singleton — it will be excluded from leak reports.
 * The disposable is still tracked (so its descendants can root through it).
 */
export function markAsSingleton<T extends IDisposable>(singleton: T): T {
  disposableTracker?.markAsSingleton(singleton)
  return singleton
}

/**
 * Manages a collection of disposable values.
 */
export class DisposableStore implements IDisposable {
  static DISABLE_DISPOSED_WARNING = false

  private readonly _toDispose = new Set<IDisposable>()
  private _isDisposed = false

  constructor() {
    trackDisposable(this)
  }

  /**
   * Dispose of all registered disposables and mark this object as disposed.
   */
  public dispose(): void {
    if (this._isDisposed) {
      return
    }
    markAsDisposed(this)
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
    setParentOfDisposable(o, this)
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
    if (this._toDispose.has(o)) {
      this._toDispose.delete(o)
      setParentOfDisposable(o, null)
    }
  }
}

/**
 * Abstract base class for a {@link IDisposable disposable} object.
 */
export abstract class Disposable implements IDisposable {
  static readonly None = Object.freeze<IDisposable>({ dispose() {} })

  protected readonly _store = new DisposableStore()

  constructor() {
    trackDisposable(this)
    setParentOfDisposable(this._store, this)
  }

  public dispose(): void {
    markAsDisposed(this)
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

  constructor() {
    trackDisposable(this)
  }

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value
  }

  set value(value: T | undefined) {
    if (this._isDisposed || value === this._value) {
      return
    }
    this._value?.dispose()
    this._value = value
    if (value) {
      setParentOfDisposable(value, this)
    }
  }

  clear(): void {
    this.value = undefined
  }

  dispose(): void {
    this._isDisposed = true
    markAsDisposed(this)
    this._value?.dispose()
    this._value = undefined
  }

  /**
   * Clears the value without disposing it. The caller takes ownership.
   */
  clearAndLeak(): T | undefined {
    const oldValue = this._value
    this._value = undefined
    if (oldValue) {
      setParentOfDisposable(oldValue, null)
    }
    return oldValue
  }
}
