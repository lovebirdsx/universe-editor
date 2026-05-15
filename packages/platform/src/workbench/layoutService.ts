/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IWorkbenchLayoutService (workbench/services/layout/browser/layoutService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export const enum PartId {
  ActivityBar = 'activityBar',
  SideBar = 'sideBar',
  EditorArea = 'editorArea',
  Panel = 'panel',
  StatusBar = 'statusBar',
}

export interface IPartVisibilityChangeEvent {
  readonly part: PartId
  readonly visible: boolean
}

/** Immutable snapshot of part visibility. */
export interface LayoutState {
  readonly visible: Readonly<Record<PartId, boolean>>
}

export interface ILayoutService {
  readonly _serviceBrand: undefined

  getVisible(part: PartId): boolean
  setVisible(part: PartId, visible: boolean): void
  toggleVisible(part: PartId): void

  getSnapshot(): LayoutState
  subscribe(listener: () => void): IDisposable

  /** @deprecated Legacy event. Prefer subscribe + getSnapshot. */
  readonly onDidChangePartVisibility: Event<IPartVisibilityChangeEvent>
}

export const ILayoutService = createDecorator<ILayoutService>('layoutService')
