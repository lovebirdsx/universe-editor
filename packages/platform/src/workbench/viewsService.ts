/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IViewsService (workbench/services/views/common/viewsService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'

export interface IViewsService {
  readonly _serviceBrand: undefined

  /** Make a view container visible in the SideBar / Panel. */
  openViewContainer(containerId: string): void
  closeViewContainer(containerId: string): void
  getActiveViewContainerId(location: number): string | undefined

  readonly activeContainerByLocation: IObservable<Readonly<Record<number, string | undefined>>>
}

export const IViewsService = createDecorator<IViewsService>('viewsService')
