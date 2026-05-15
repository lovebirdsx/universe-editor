/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { IViewsService } from '@universe-editor/platform'
import { ViewContainerLocation, ViewContainerRegistry } from '@universe-editor/platform'

export class ViewsService implements IViewsService {
  declare readonly _serviceBrand: undefined

  readonly activeContainerByLocation = observableValue<
    Readonly<Record<number, string | undefined>>
  >('ViewsService.activeContainerByLocation', {})

  openViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const cur = this.activeContainerByLocation.get()
    if (cur[location] === containerId) return
    this.activeContainerByLocation.set({ ...cur, [location]: containerId }, undefined)
  }

  closeViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const cur = this.activeContainerByLocation.get()
    if (cur[location] !== containerId) return
    const next = { ...cur }
    delete next[location]
    this.activeContainerByLocation.set(next, undefined)
  }

  getActiveViewContainerId(location: number): string | undefined {
    return this.activeContainerByLocation.get()[location]
  }

  private _getLocation(id: string): number {
    const descriptor = ViewContainerRegistry.getViewContainer(id)
    return descriptor?.location ?? ViewContainerLocation.SideBar
  }
}
