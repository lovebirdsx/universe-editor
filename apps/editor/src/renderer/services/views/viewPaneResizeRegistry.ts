/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewPaneResizeRegistry — viewId → "resize this pane by N px" handler.
 *
 *  The ctrl+alt+shift+arrow actions resize a Part's chrome by default. Inside a
 *  SideBar / SecondarySideBar stack that would be a no-op for the vertical axis
 *  (the sidebar is as tall as the window), while the pane the focus sits in does
 *  have a size of its own. Only the mounted container owns the Allotment handle,
 *  and only the action knows which view is focused, so the capability is
 *  published through DI rather than reached through the DOM.
 *
 *  Interface lives renderer-side on purpose (contrast IFocusableRegistry, which
 *  ILayoutService consults): the capability belongs to a mounted React component
 *  and no platform service consumes it.
 *
 *  Handlers are keyed by view id, not by container: a view is rendered by
 *  exactly one mounted container, so a lookup never has to guess the owner.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  createDecorator,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'

/**
 * Resize the pane hosting `viewId` by `deltaPx` (signed: > 0 grows, < 0 shrinks).
 * Returns false when this container does not host the view, or when not a pixel
 * can move (lone pane, no expanded neighbour, geometry not reported yet).
 */
export type ViewPaneResizeHandler = (viewId: string, deltaPx: number) => boolean

export interface IViewPaneResizeRegistry {
  readonly _serviceBrand: undefined

  /** Publish `handler` for every id in `viewIds`. Dispose to retract. */
  register(viewIds: readonly string[], handler: ViewPaneResizeHandler): IDisposable
  /** Route a resize request to the container hosting `viewId`; false = nobody handled it. */
  resize(viewId: string, deltaPx: number): boolean
}

export const IViewPaneResizeRegistry =
  createDecorator<IViewPaneResizeRegistry>('viewPaneResizeRegistry')

export class ViewPaneResizeRegistry extends Disposable implements IViewPaneResizeRegistry {
  declare readonly _serviceBrand: undefined

  private readonly _handlers = new Map<string, ViewPaneResizeHandler>()

  register(viewIds: readonly string[], handler: ViewPaneResizeHandler): IDisposable {
    for (const viewId of viewIds) this._handlers.set(viewId, handler)
    const token: IDisposable = toDisposable(() => {
      for (const viewId of viewIds) {
        // A view moved to another container can be re-registered before this
        // entry is retracted; only drop the ids this handler still owns.
        if (this._handlers.get(viewId) === handler) this._handlers.delete(viewId)
      }
      this._store.deleteAndLeak(token)
    })
    this._register(token)
    return token
  }

  resize(viewId: string, deltaPx: number): boolean {
    return this._handlers.get(viewId)?.(viewId, deltaPx) ?? false
  }
}
