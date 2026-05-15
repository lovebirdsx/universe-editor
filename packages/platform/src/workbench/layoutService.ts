/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IWorkbenchLayoutService (workbench/services/layout/browser/layoutService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'

export const enum PartId {
  ActivityBar = 'activityBar',
  SideBar = 'sideBar',
  EditorArea = 'editorArea',
  Panel = 'panel',
  StatusBar = 'statusBar',
}

export interface ILayoutService {
  readonly _serviceBrand: undefined

  getVisible(part: PartId): boolean
  setVisible(part: PartId, visible: boolean): void
  toggleVisible(part: PartId): void

  readonly visible: IObservable<Readonly<Record<PartId, boolean>>>
}

export const ILayoutService = createDecorator<ILayoutService>('layoutService')
