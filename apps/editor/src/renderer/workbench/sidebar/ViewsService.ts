/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IViewsService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type {
  IViewsService,
  IViewContainerVisibilityChangeEvent,
  ViewsState,
  IDisposable,
} from '@universe-editor/platform'
import { ViewContainerLocation } from '@universe-editor/platform'

const EMPTY_STATE: ViewsState = Object.freeze({
  activeContainerByLocation: Object.freeze({}) as Readonly<Record<number, string | undefined>>,
})

export class ViewsService implements IViewsService {
  declare readonly _serviceBrand: undefined

  private _state: ViewsState = EMPTY_STATE

  private readonly _onChange = new Emitter<void>()
  private readonly _onDidChangeViewContainerVisibility =
    new Emitter<IViewContainerVisibilityChangeEvent>()
  readonly onDidChangeViewContainerVisibility = this._onDidChangeViewContainerVisibility.event

  getSnapshot(): ViewsState {
    return this._state
  }

  subscribe(listener: () => void): IDisposable {
    return this._onChange.event(listener)
  }

  openViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const prev = this._state.activeContainerByLocation[location]
    if (prev === containerId) return

    this._commit(
      Object.freeze({
        activeContainerByLocation: Object.freeze({
          ...this._state.activeContainerByLocation,
          [location]: containerId,
        }),
      }),
    )

    this._onDidChangeViewContainerVisibility.fire({ containerId, visible: true, location })
    if (prev !== undefined) {
      this._onDidChangeViewContainerVisibility.fire({
        containerId: prev,
        visible: false,
        location,
      })
    }
  }

  closeViewContainer(containerId: string): void {
    const location = this._getLocation(containerId)
    const current = this._state.activeContainerByLocation[location]
    if (current !== containerId) return

    const next = { ...this._state.activeContainerByLocation }
    delete next[location]
    this._commit(Object.freeze({ activeContainerByLocation: Object.freeze(next) }))

    this._onDidChangeViewContainerVisibility.fire({ containerId, visible: false, location })
  }

  getActiveViewContainerId(location: number): string | undefined {
    return this._state.activeContainerByLocation[location]
  }

  private _getLocation(_id: string): number {
    // Default to SideBar; Panel containers could be resolved via ViewContainerRegistry.
    return ViewContainerLocation.SideBar
  }

  private _commit(next: ViewsState): void {
    if (next === this._state) return
    this._state = next
    this._onChange.fire()
  }
}
