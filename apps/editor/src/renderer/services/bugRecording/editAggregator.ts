/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Collapses per-keystroke model changes into one "edited file X, N times" event.
 *  Recording every content change would bury the timeline in noise an AI has to
 *  wade through; what matters for reproduction is which files changed, not keys.
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_DEBOUNCE_MS = 1500

export interface EditAggregatorFlush {
  readonly resource: string
  readonly count: number
}

export class EditAggregator {
  private readonly _counts = new Map<string, number>()
  private _timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly _onFlush: (edits: readonly EditAggregatorFlush[]) => void,
    private readonly _debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {}

  record(resource: string): void {
    this._counts.set(resource, (this._counts.get(resource) ?? 0) + 1)
    if (this._timer !== undefined) clearTimeout(this._timer)
    this._timer = setTimeout(() => this.flush(), this._debounceMs)
  }

  flush(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    if (this._counts.size === 0) return
    const edits = [...this._counts.entries()].map(([resource, count]) => ({ resource, count }))
    this._counts.clear()
    this._onFlush(edits)
  }

  dispose(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    this._counts.clear()
  }
}
