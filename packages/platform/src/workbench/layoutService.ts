/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IWorkbenchLayoutService (workbench/services/layout/browser/layoutService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'

export const enum PartId {
  ActivityBar = 'activityBar',
  SideBar = 'sideBar',
  SecondarySideBar = 'secondarySideBar',
  EditorArea = 'editorArea',
  Panel = 'panel',
  StatusBar = 'statusBar',
}

export interface LayoutSizes {
  /** SideBar width in px (excludes ActivityBar). */
  sidebar: number
  /** SecondarySideBar width in px. */
  secondarySidebar: number
  /** Panel height in px. */
  panel: number
}

export interface ILayoutService {
  readonly _serviceBrand: undefined

  getVisible(part: PartId): boolean
  setVisible(part: PartId, visible: boolean): void
  toggleVisible(part: PartId): void

  readonly visible: IObservable<Readonly<Record<PartId, boolean>>>

  readonly sizes: IObservable<Readonly<LayoutSizes>>
  setSize(key: keyof LayoutSizes, value: number): void

  /** Load persisted layout (visible + sizes) from storage. Safe to call when storage is unavailable. */
  load(): Promise<void>
  /** Force-flush any pending persist. */
  save(): Promise<void>
}

export const ILayoutService = createDecorator<ILayoutService>('layoutService')
