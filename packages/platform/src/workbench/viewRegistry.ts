/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's ViewContainerRegistry / ViewDescriptorService.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { Emitter } from '../base/event.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'

/** Where the container lives in the workbench layout. */
export const enum ViewContainerLocation {
  SideBar = 0,
  SecondarySideBar = 1,
  Panel = 2,
}

export interface IViewContainerDescriptor {
  readonly id: string
  readonly label: string
  /** Codicon identifier, e.g. 'files', 'search', 'extensions' */
  readonly icon: string
  readonly order: number
  readonly location: ViewContainerLocation
  /** False ⇒ the whole container cannot be dragged to another location. Defaults to true. */
  readonly canMoveView?: boolean
  /** True ⇒ views from other containers cannot be dropped here. Defaults to false. */
  readonly rejectAddedViews?: boolean
  /** Internal marker: a runtime-generated container that auto-removes when emptied. */
  readonly generated?: boolean
}

export interface IViewDescriptor {
  readonly id: string
  readonly name: string
  /** Default home container; the runtime location is owned by IViewDescriptorService. */
  readonly containerId: string
  /** React component factory; renderer resolves this at render time. */
  readonly componentKey: string
  readonly order: number
  /** False ⇒ this view cannot be moved out of its container. Defaults to true. */
  readonly canMoveView?: boolean
}

// -------- ViewContainerRegistry --------

export interface IViewContainerRegistry {
  registerViewContainer(descriptor: IViewContainerDescriptor): IDisposable
  deregisterViewContainer(id: string): void
  getViewContainer(id: string): IViewContainerDescriptor | undefined
  getViewContainers(location: ViewContainerLocation): readonly IViewContainerDescriptor[]
  getAllViewContainers(): readonly IViewContainerDescriptor[]
  readonly onDidRegisterViewContainer: Event<IViewContainerDescriptor>
  readonly onDidDeregisterViewContainer: Event<IViewContainerDescriptor>
}

class ViewContainerRegistryImpl implements IViewContainerRegistry {
  private readonly _containers = new Map<string, IViewContainerDescriptor>()
  private readonly _onDidRegister = new Emitter<IViewContainerDescriptor>()
  private readonly _onDidDeregister = new Emitter<IViewContainerDescriptor>()

  readonly onDidRegisterViewContainer: Event<IViewContainerDescriptor> = this._onDidRegister.event
  readonly onDidDeregisterViewContainer: Event<IViewContainerDescriptor> =
    this._onDidDeregister.event

  registerViewContainer(descriptor: IViewContainerDescriptor): IDisposable {
    this._containers.set(descriptor.id, descriptor)
    this._onDidRegister.fire(descriptor)
    return toDisposable(() => this.deregisterViewContainer(descriptor.id))
  }

  deregisterViewContainer(id: string): void {
    const descriptor = this._containers.get(id)
    if (!descriptor) return
    this._containers.delete(id)
    this._onDidDeregister.fire(descriptor)
  }

  getViewContainer(id: string): IViewContainerDescriptor | undefined {
    return this._containers.get(id)
  }

  getViewContainers(location: ViewContainerLocation): readonly IViewContainerDescriptor[] {
    return [...this._containers.values()]
      .filter((d) => d.location === location)
      .sort((a, b) => a.order - b.order)
  }

  getAllViewContainers(): readonly IViewContainerDescriptor[] {
    return [...this._containers.values()]
  }
}

export const ViewContainerRegistry: IViewContainerRegistry = new ViewContainerRegistryImpl()

// -------- ViewRegistry --------

export interface IViewRegistry {
  registerView(descriptor: IViewDescriptor): IDisposable
  getView(id: string): IViewDescriptor | undefined
  getViewsForContainer(containerId: string): readonly IViewDescriptor[]
  getAllViews(): readonly IViewDescriptor[]
  readonly onDidRegisterView: Event<IViewDescriptor>
  readonly onDidDeregisterView: Event<IViewDescriptor>
}

class ViewRegistryImpl implements IViewRegistry {
  private readonly _views = new Map<string, IViewDescriptor>()
  private readonly _onDidRegister = new Emitter<IViewDescriptor>()
  private readonly _onDidDeregister = new Emitter<IViewDescriptor>()

  readonly onDidRegisterView: Event<IViewDescriptor> = this._onDidRegister.event
  readonly onDidDeregisterView: Event<IViewDescriptor> = this._onDidDeregister.event

  registerView(descriptor: IViewDescriptor): IDisposable {
    this._views.set(descriptor.id, descriptor)
    this._onDidRegister.fire(descriptor)
    return toDisposable(() => {
      const existing = this._views.get(descriptor.id)
      if (existing !== descriptor) return
      this._views.delete(descriptor.id)
      this._onDidDeregister.fire(descriptor)
    })
  }

  getView(id: string): IViewDescriptor | undefined {
    return this._views.get(id)
  }

  getViewsForContainer(containerId: string): readonly IViewDescriptor[] {
    return [...this._views.values()]
      .filter((d) => d.containerId === containerId)
      .sort((a, b) => a.order - b.order)
  }

  getAllViews(): readonly IViewDescriptor[] {
    return [...this._views.values()]
  }
}

export const ViewRegistry: IViewRegistry = new ViewRegistryImpl()
