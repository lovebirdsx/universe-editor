/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Renderer-side registry mapping IViewDescriptor.componentKey -> React component.
 *  Lives in the renderer (platform must stay React/DOM-free); the platform-side
 *  ViewRegistry only stores the string componentKey, which this registry resolves
 *  at render time. Mirrors the platform ViewRegistry's singleton + IDisposable
 *  registration style.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import {
  IDisposable,
  IViewDescriptor,
  ViewRegistry,
  combinedDisposable,
  toDisposable,
} from '@universe-editor/platform'

export interface IViewComponentRegistry {
  register(componentKey: string, component: ComponentType): IDisposable
  get(componentKey: string): ComponentType | undefined
}

class ViewComponentRegistryImpl implements IViewComponentRegistry {
  private readonly _components = new Map<string, ComponentType>()

  register(componentKey: string, component: ComponentType): IDisposable {
    this._components.set(componentKey, component)
    return toDisposable(() => {
      if (this._components.get(componentKey) === component) {
        this._components.delete(componentKey)
      }
    })
  }

  get(componentKey: string): ComponentType | undefined {
    return this._components.get(componentKey)
  }
}

export const ViewComponentRegistry: IViewComponentRegistry = new ViewComponentRegistryImpl()

/** A view descriptor minus the renderer-only componentKey (derived from `id`). */
export type ViewRegistration = Omit<IViewDescriptor, 'componentKey'>

/**
 * Single-point view registration: declares the descriptor and binds its React
 * component together, deriving a stable componentKey from the view `id`. This
 * removes the cross-file hardcoded-string coupling of the old "three places to
 * edit" flow (descriptor + componentKey + component binding). Extensions may
 * still use the lower-level `ViewRegistry.registerView` + `ViewComponentRegistry.register`.
 */
export function registerViewWithComponent(
  registration: ViewRegistration,
  component: ComponentType,
): IDisposable {
  return combinedDisposable(
    ViewRegistry.registerView({ ...registration, componentKey: registration.id }),
    ViewComponentRegistry.register(registration.id, component),
  )
}
