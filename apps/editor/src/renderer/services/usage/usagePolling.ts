/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PollingLoop — a thin visibility-aware interval loop shared by the usage
 *  services. It owns the timer and the visibilitychange listener; what each
 *  tick does (which targets to refresh) stays with the service's onTick
 *  callback.
 *
 *  Renderer setInterval is throttled while the window is hidden, so a hidden
 *  window pauses the loop and a visible one restarts it with an immediate tick.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type ILogger } from '@universe-editor/platform'

/** The document slice the loop needs; the real one resolves lazily so node tests can inject a fake. */
export interface PollingDocument {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface PollingLoopOptions {
  /** Current interval in ms, re-read on every (re)start. */
  readonly interval: () => number
  /** Per-tick work, also run once when the window becomes visible again. */
  readonly onTick: () => void | Promise<void>
  readonly logger?: ILogger
  /** Injectable visibility owner for tests; defaults to the lazily-resolved global document. */
  readonly document?: PollingDocument
}

export class PollingLoop extends Disposable {
  private _timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly _options: PollingLoopOptions) {
    super()
    this._register({ dispose: () => this.stop() })
    this._registerVisibility()
  }

  /** Stop and re-arm with the current interval; a hidden window keeps it stopped. */
  restart(): void {
    this.stop()
    if (this._isHidden()) return
    this._timer = setInterval(() => void this._safeTick(), this._options.interval())
  }

  /** Clear the interval; the visibility listener stays armed so a visible window restarts it. */
  stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }

  private _registerVisibility(): void {
    const doc = this._document()
    if (doc === undefined) return
    const onVisibility = (): void => {
      if (doc.visibilityState === 'hidden') {
        this.stop()
      } else {
        void this._safeTick()
        this.restart()
      }
    }
    doc.addEventListener('visibilitychange', onVisibility)
    this._register({ dispose: () => doc.removeEventListener('visibilitychange', onVisibility) })
  }

  private _safeTick(): void {
    Promise.resolve(this._options.onTick()).catch((error) => {
      this._options.logger?.warn(
        `polling tick failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  private _document(): PollingDocument | undefined {
    if (this._options.document !== undefined) return this._options.document
    return typeof document !== 'undefined' ? (document as unknown as PollingDocument) : undefined
  }

  private _isHidden(): boolean {
    return this._document()?.visibilityState === 'hidden'
  }
}
