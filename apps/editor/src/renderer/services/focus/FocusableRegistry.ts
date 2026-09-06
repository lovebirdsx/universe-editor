/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer implementation of IFocusableRegistry. viewId → element getter map.
 *
 *  Two tiers per view: the view's own registration (an input, a tree) and the
 *  container body's fallback. `get` prefers the primary but yields the fallback
 *  whenever the primary is absent or currently resolves to null — views that
 *  register a tree only once they have content would otherwise be unfocusable
 *  in their empty state.
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
