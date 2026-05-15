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
}

export interface IViewDescriptor {
  readonly id: string
  readonly name: string
  readonly containerId: string
  /** React component factory; renderer resolves this at render time. */
  readonly componentKey: string
  readonly order: number
}

// -------- ViewContainerRegistry --------

export interface IViewContainerRegistry {
  registerViewContainer(descriptor: IViewContainerDescriptor): IDisposable
  getViewContainer(id: string): IViewContainerDescriptor | undefined
  getViewContainers(location: ViewContainerLocation): readonly IViewContainerDescriptor[]
  readonly onDidRegisterViewContainer: Event<IViewContainerDescriptor>
}

class ViewContainerRegistryImpl implements IViewContainerRegistry {
  private readonly _containers = new Map<string, IViewContainerDescriptor>()
  private readonly _onDidRegister = new Emitter<IViewContainerDescriptor>()

  readonly onDidRegisterViewContainer: Event<IViewContainerDescriptor> = this._onDidRegister.event

  registerViewContainer(descriptor: IViewContainerDescriptor): IDisposable {
    this._containers.set(descriptor.id, descriptor)
    this._onDidRegister.fire(descriptor)
    return toDisposable(() => this._containers.delete(descriptor.id))
  }

  getViewContainer(id: string): IViewContainerDescriptor | undefined {
    return this._containers.get(id)
  }

  getViewContainers(location: ViewContainerLocation): readonly IViewContainerDescriptor[] {
    return [...this._containers.values()]
      .filter((d) => d.location === location)
      .sort((a, b) => a.order - b.order)
  }
}

export const ViewContainerRegistry: IViewContainerRegistry = new ViewContainerRegistryImpl()

// -------- ViewRegistry --------

export interface IViewRegistry {
  registerView(descriptor: IViewDescriptor): IDisposable
  getViewsForContainer(containerId: string): readonly IViewDescriptor[]
  readonly onDidRegisterView: Event<IViewDescriptor>
}

class ViewRegistryImpl implements IViewRegistry {
  private readonly _views = new Map<string, IViewDescriptor>()
  private readonly _onDidRegister = new Emitter<IViewDescriptor>()

  readonly onDidRegisterView: Event<IViewDescriptor> = this._onDidRegister.event

  registerView(descriptor: IViewDescriptor): IDisposable {
    this._views.set(descriptor.id, descriptor)
    this._onDidRegister.fire(descriptor)
    return toDisposable(() => this._views.delete(descriptor.id))
  }

  getViewsForContainer(containerId: string): readonly IViewDescriptor[] {
    return [...this._views.values()]
      .filter((d) => d.containerId === containerId)
      .sort((a, b) => a.order - b.order)
  }
}

export const ViewRegistry: IViewRegistry = new ViewRegistryImpl()
