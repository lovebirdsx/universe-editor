/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IViewDescriptorService
 *  (workbench/services/views/browser/viewDescriptorService.ts).
 *
 *  Owns the *runtime* mapping between views and view containers. The static
 *  ViewRegistry / ViewContainerRegistry only declare a view's default home; this
 *  service layers user customizations (drag-to-move, reorder, collapse, size,
 *  generated containers) on top and persists them. All UI reads through here so a
 *  moved view shows up in its new container without touching the registries.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'
import type { IViewContainerDescriptor, IViewDescriptor } from './viewRegistry.js'
import type { ViewContainerLocation } from './viewRegistry.js'

/** Per-view runtime state owned by the descriptor service (collapse / size / order). */
export interface IViewState {
  readonly collapsed?: boolean
  readonly size?: number
  readonly order?: number
}

export interface IViewDescriptorService {
  readonly _serviceBrand: undefined

  /**
   * Bumps on every mutation (move / reorder / collapse / size / generated
   * container add-remove). UI subscribes and re-queries the methods below.
   */
  readonly version: IObservable<number>

  // -- container queries ----------------------------------------------------
  getViewContainerById(id: string): IViewContainerDescriptor | undefined
  /** Containers at a location, in display order (custom order honored). */
  getViewContainersByLocation(location: ViewContainerLocation): readonly IViewContainerDescriptor[]
  getViewContainerLocation(containerId: string): ViewContainerLocation | undefined

  // -- view queries ---------------------------------------------------------
  /** Views currently homed in a container, in display order. */
  getViewsByContainer(containerId: string): readonly IViewDescriptor[]
  /** The container a view currently lives in (custom location, else default). */
  getViewContainerByViewId(viewId: string): IViewContainerDescriptor | undefined
  getViewLocationById(viewId: string): ViewContainerLocation | undefined
  getDefaultContainerById(viewId: string): IViewContainerDescriptor | undefined

  // -- mutations ------------------------------------------------------------
  /** Move views into an existing container (cross-container drop). */
  moveViewsToContainer(viewIds: readonly string[], targetContainerId: string): void
  /** Move a single view to a location, generating a fresh container to hold it. */
  moveViewToLocation(viewId: string, location: ViewContainerLocation): void
  /** Move an entire container (with all its views) to another location. */
  moveViewContainerToLocation(containerId: string, location: ViewContainerLocation): void
  /** Reorder a view within its container by dropping `viewId` before/after `targetViewId`. */
  moveViewInContainer(containerId: string, viewId: string, targetViewId: string): void
  /** Reorder a container within its location by dropping it before/after another. */
  moveContainerInLocation(containerId: string, targetContainerId: string): void

  // -- per-view state -------------------------------------------------------
  getViewState(viewId: string): IViewState
  setViewCollapsed(viewId: string, collapsed: boolean): void
  setViewSizes(sizes: ReadonlyArray<{ id: string; size: number }>): void

  /** Reset all customizations back to registry defaults. */
  reset(): void

  /** Force-flush any pending debounced persist. Resolves when on disk. */
  save(): Promise<void>
}

export const IViewDescriptorService =
  createDecorator<IViewDescriptorService>('viewDescriptorService')
