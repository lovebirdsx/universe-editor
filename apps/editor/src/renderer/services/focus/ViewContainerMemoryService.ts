/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ViewContainerMemoryService — containerId → lastFocusedViewId.
 *
 *  Pure storage; FocusStackService writes to it, LayoutService.focusPart reads
 *  it to decide whether to delegate to focusView. Keeping this side-effect-free
 *  avoids a DI cycle between LayoutService and FocusStack.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, createDecorator } from '@universe-editor/platform'

export interface IViewContainerMemoryService {
  readonly _serviceBrand: undefined

  readonly onDidChange: Emitter<string>['event']

  getLastFocusedView(containerId: string): string | undefined
  setLastFocusedView(containerId: string, viewId: string): void
}

export const IViewContainerMemoryService = createDecorator<IViewContainerMemoryService>(
  'viewContainerMemoryService',
)

export class ViewContainerMemoryService extends Disposable implements IViewContainerMemoryService {
  declare readonly _serviceBrand: undefined

  private readonly _byContainer = new Map<string, string>()
  private readonly _onDidChange = this._register(new Emitter<string>())
  readonly onDidChange = this._onDidChange.event

  getLastFocusedView(containerId: string): string | undefined {
    return this._byContainer.get(containerId)
  }

  setLastFocusedView(containerId: string, viewId: string): void {
    if (this._byContainer.get(containerId) === viewId) return
    this._byContainer.set(containerId, viewId)
    this._onDidChange.fire(containerId)
  }
}
