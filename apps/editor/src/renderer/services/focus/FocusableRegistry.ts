/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer implementation of IFocusableRegistry. viewId → element getter map.
 *
 *  Two tiers per view: the view's own registration (an input, a tree) and the
 *  container body's fallback. `get` prefers the primary but yields the fallback
 *  whenever the primary is absent or currently resolves to null — views that
 *  register a tree only once they have content would otherwise be unfocusable
 *  in their empty state.
 *
 *  When a *primary* registers while the view's fallback currently owns DOM
 *  focus, focus is handed over to the primary. That closes the race where
 *  focusView() lands on the fallback because the view's real content was
 *  still loading (e.g. Commit Changes fetching its payload), and the content
 *  arrives after focusView() already returned: without the handover, focus
 *  would stay stranded on the container body forever.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  toDisposable,
  type FocusableElementGetter,
  type IDisposable,
  type IFocusableRegistrationOptions,
  type IFocusableRegistry,
} from '@universe-editor/platform'

export class FocusableRegistry extends Disposable implements IFocusableRegistry {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, FocusableElementGetter>()
  private readonly _fallbacks = new Map<string, FocusableElementGetter>()
  private readonly _onDidChange = this._register(new Emitter<string>())
  readonly onDidChange = this._onDidChange.event

  register(
    viewId: string,
    getter: FocusableElementGetter,
    options?: IFocusableRegistrationOptions,
  ): IDisposable {
    const map = options?.fallback ? this._fallbacks : this._entries
    map.set(viewId, getter)
    if (!options?.fallback) {
      this._handFocusToPrimaryIfParkedOnFallback(viewId, getter)
    }
    this._onDidChange.fire(viewId)
    const token: IDisposable = toDisposable(() => {
      if (map.get(viewId) === getter) {
        map.delete(viewId)
        this._onDidChange.fire(viewId)
      }
      this._store.deleteAndLeak(token)
    })
    this._register(token)
    return token
  }

  /**
   * The view's own focusable content just mounted. If the view's fallback
   * (the ViewBody wrapper) currently holds DOM focus — i.e. focusView() had
   * to settle for the placeholder while the content was still loading — move
   * focus onto the real target so keyboard navigation works. Focus anywhere
   * else (another view, the editor, the graph) is left alone.
   */
  private _handFocusToPrimaryIfParkedOnFallback(
    viewId: string,
    primary: FocusableElementGetter,
  ): void {
    if (typeof document === 'undefined') return
    const active = document.activeElement
    if (!active) return
    const fallbackEl = this._fallbacks.get(viewId)?.()
    if (!fallbackEl) return
    if (fallbackEl !== active && fallbackEl.contains?.(active) !== true) return
    const el = primary()
    if (!el) return
    ;(el as { focus?(): void } | null)?.focus?.()
  }

  get(viewId: string): FocusableElementGetter | undefined {
    const primary = this._entries.get(viewId)
    const fallback = this._fallbacks.get(viewId)
    if (!primary) return fallback
    if (!fallback) return primary
    // Resolved at call time, not registration time: a view whose primary target
    // mounts asynchronously (a tree behind a load) reports null until then, and
    // the caller must still get something focusable in the meantime.
    return () => primary() ?? fallback()
  }
}
