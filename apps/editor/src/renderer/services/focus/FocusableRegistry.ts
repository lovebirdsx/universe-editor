/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer implementation of IFocusableRegistry. viewId → element getter map.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  toDisposable,
  type FocusableElementGetter,
  type IDisposable,
  type IFocusableRegistry,
} from '@universe-editor/platform'

export class FocusableRegistry extends Disposable implements IFocusableRegistry {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, FocusableElementGetter>()
  private readonly _onDidChange = this._register(new Emitter<string>())
  readonly onDidChange = this._onDidChange.event

  register(viewId: string, getter: FocusableElementGetter): IDisposable {
    this._entries.set(viewId, getter)
    this._onDidChange.fire(viewId)
    const token: IDisposable = toDisposable(() => {
      if (this._entries.get(viewId) === getter) {
        this._entries.delete(viewId)
        this._onDidChange.fire(viewId)
      }
      this._store.deleteAndLeak(token)
    })
    this._register(token)
    return token
  }

  get(viewId: string): FocusableElementGetter | undefined {
    return this._entries.get(viewId)
  }
}
