/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IViewsService (workbench/services/views/common/viewsService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export interface IViewContainerVisibilityChangeEvent {
  readonly containerId: string
  readonly visible: boolean
  readonly location: number
}

/**
 * Immutable snapshot of views state. `activeContainerByLocation` maps each
 * ViewContainerLocation number to the currently visible container id (or undefined).
 */
export interface ViewsState {
  readonly activeContainerByLocation: Readonly<Record<number, string | undefined>>
}

export interface IViewsService {
  readonly _serviceBrand: undefined

  /** Make a view container visible in the SideBar / Panel. */
  openViewContainer(containerId: string): void
  closeViewContainer(containerId: string): void
  getActiveViewContainerId(location: number): string | undefined

  getSnapshot(): ViewsState
  subscribe(listener: () => void): IDisposable

  /** @deprecated Legacy event. Prefer subscribe + getSnapshot. */
  readonly onDidChangeViewContainerVisibility: Event<IViewContainerVisibilityChangeEvent>
}

export const IViewsService = createDecorator<IViewsService>('viewsService')
