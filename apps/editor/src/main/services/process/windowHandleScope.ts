import { Event } from '@universe-editor/platform'

/**
 * Per-window view over an app-wide stdio host: events for handles this window
 * did not start are dropped in main, so N windows don't each pay IPC for every
 * other window's host traffic (observed as 7× fan-out stalling explorer replies).
 */
export class WindowHandleScope {
  private readonly _handles = new Set<string>()
  private _pendingStarts = 0

  track<T extends { readonly handle: string }>(start: Promise<T>): Promise<T> {
    this._pendingStarts++
    return start.then(
      (result) => {
        this._pendingStarts--
        this._handles.add(result.handle)
        return result
      },
      (err: unknown) => {
        this._pendingStarts--
        throw err
      },
    )
  }

  filter<E extends { readonly handle: string }>(event: Event<E>): Event<E> {
    return Event.filter(event, (e) => this._accepts(e.handle))
  }

  filterExit<E extends { readonly handle: string }>(event: Event<E>): Event<E> {
    return Event.filter(event, (e) => {
      if (!this._accepts(e.handle)) return false
      // Deferred so every listener of this same fire still matches.
      queueMicrotask(() => this._handles.delete(e.handle))
      return true
    })
  }

  // A remote start's reply and the child's first stdout can arrive in one batch, ahead of the
  // reply's `.then`; passing everything while a start is in flight keeps that first frame.
  private _accepts(handle: string): boolean {
    return this._pendingStarts > 0 || this._handles.has(handle)
  }
}
