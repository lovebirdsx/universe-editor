/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererFocusTrackerService — document-level focusin/focusout observer.
 *
 *  Implementation details:
 *  - One delegated `focusin` + `focusout` listener on the document. Per-Part
 *    or per-element trackers are layered on top via `trackElement`.
 *  - A `setTimeout(0)` debounce merges adjacent focusout/focusin pairs (the
 *    "transient body focus" gap) so subscribers only see settled transitions.
 *  - On focus leaving the window entirely, fires with `current: null` after the
 *    debounce, but does NOT clear element trackers — they re-fire `true` when
 *    the user clicks back into a tracked subtree.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  toDisposable,
  type Event,
  type IDisposable,
  type IFocusChangeEvent,
  type IFocusTrackerService,
  type IFocusableElement,
} from '@universe-editor/platform'

interface ElementTracker {
  readonly element: IFocusableElement
  readonly listener: (focused: boolean) => void
  lastState: boolean
}

export class RendererFocusTrackerService extends Disposable implements IFocusTrackerService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidFocusChange = this._register(new Emitter<IFocusChangeEvent>())
  readonly onDidFocusChange: Event<IFocusChangeEvent> = this._onDidFocusChange.event

  private _current: IFocusableElement | null = null
  private _pendingTarget: IFocusableElement | null = null
  private _settleTimer: ReturnType<typeof setTimeout> | undefined
  private _trackers = new Set<ElementTracker>()

  constructor(private readonly _doc: Document) {
    super()
    this._current =
      _doc.activeElement instanceof HTMLElement && _doc.activeElement !== _doc.body
        ? (_doc.activeElement as unknown as IFocusableElement)
        : null
    this._pendingTarget = this._current
    const onFocusIn = (e: FocusEvent): void => {
      const target = (e.target instanceof HTMLElement ? e.target : null) as
        | (IFocusableElement & HTMLElement)
        | null
      this._scheduleSettle(target)
    }
    const onFocusOut = (): void => {
      // focusout fires before the next focusin lands. Schedule a settle pass
      // with the current candidate; the corresponding focusin overwrites
      // `_pendingTarget` if focus is moving within the window.
      this._scheduleSettle(this._pendingTarget)
    }
    _doc.addEventListener('focusin', onFocusIn, true)
    _doc.addEventListener('focusout', onFocusOut, true)
    this._register(
      toDisposable(() => {
        _doc.removeEventListener('focusin', onFocusIn, true)
        _doc.removeEventListener('focusout', onFocusOut, true)
        if (this._settleTimer !== undefined) clearTimeout(this._settleTimer)
      }),
    )
  }

  get current(): IFocusableElement | null {
    return this._current
  }

  trackElement(element: IFocusableElement, listener: (focused: boolean) => void): IDisposable {
    const entry: ElementTracker = {
      element,
      listener,
      lastState: this._elementContainsCurrent(element),
    }
    this._trackers.add(entry)
    return toDisposable(() => {
      this._trackers.delete(entry)
    })
  }

  private _scheduleSettle(target: IFocusableElement | null): void {
    this._pendingTarget = target
    if (this._settleTimer !== undefined) return
    this._settleTimer = setTimeout(() => {
      this._settleTimer = undefined
      this._settle()
    }, 0)
  }

  private _settle(): void {
    const next = this._pendingTarget
    const prev = this._current
    if (prev === next) {
      // Same element resolved (transient out/in) — but still poll element trackers
      // to catch initial state or movements within tracked subtrees.
      this._notifyTrackers()
      return
    }
    this._current = next
    this._onDidFocusChange.fire({ current: next, previous: prev })
    this._notifyTrackers()
  }

  private _notifyTrackers(): void {
    for (const t of this._trackers) {
      const now = this._elementContainsCurrent(t.element)
      if (now !== t.lastState) {
        t.lastState = now
        try {
          t.listener(now)
        } catch {
          // Listeners must not throw the tracker into a bad state.
        }
      }
    }
  }

  private _elementContainsCurrent(element: IFocusableElement): boolean {
    if (this._current === null) return false
    if (this._current === element) return true
    return typeof element.contains === 'function' ? element.contains(this._current) === true : false
  }
}
