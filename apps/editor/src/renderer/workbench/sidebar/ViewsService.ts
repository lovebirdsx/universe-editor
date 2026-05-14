/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { IViewsService, IViewContainerVisibilityChangeEvent } from '@universe-editor/platform'
import { ViewContainerLocation } from '@universe-editor/platform'

export class ViewsService implements IViewsService {
  declare readonly _serviceBrand: undefined

  private readonly _activeContainerIds = new Map<number, string>()

  private readonly _emitter = new Emitter<IViewContainerVisibilityChangeEvent>()
  readonly onDidChangeViewContainerVisibility = this._emitter.event

  openViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const prev = this._activeContainerIds.get(location)
    if (prev === containerId) return
    this._activeContainerIds.set(location, containerId)
    this._emitter.fire({ containerId, visible: true, location })
    if (prev !== undefined) {
      this._emitter.fire({ containerId: prev, visible: false, location })
    }
  }

  closeViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const current = this._activeContainerIds.get(location)
    if (current !== containerId) return
    this._activeContainerIds.delete(location)
    this._emitter.fire({ containerId, visible: false, location })
  }

  getActiveViewContainerId(location: number): string | undefined {
    return this._activeContainerIds.get(location)
  }

  private _getLocation(_id: string): number {
    // Default to SideBar; Panel containers could be resolved via ViewContainerRegistry.
    return ViewContainerLocation.SideBar
  }
}
