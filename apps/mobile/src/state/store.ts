/** Minimal observable store shared by the inbox / session projections. */
export interface ReadableStore<T> {
  getState(): T
  subscribe(listener: () => void): () => void
}

export class Store<T> implements ReadableStore<T> {
  private _state: T
  private readonly _listeners = new Set<() => void>()

  constructor(initial: T) {
    this._state = initial
  }

  readonly getState = (): T => this._state

  readonly subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  setState(next: T): void {
    if (Object.is(next, this._state)) return
    this._state = next
    for (const listener of [...this._listeners]) listener()
  }
}
