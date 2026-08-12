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

/**
 * Props every view component receives at render time. `viewId` lets one shared
 * component serve many views (extension tree views all bind a single
 * componentKey and dispatch per view id); built-in single-view components
 * simply ignore it.
 */
export interface IViewComponentProps {
  readonly viewId?: string
}

export interface IViewComponentRegistry {
  register(componentKey: string, component: ComponentType<IViewComponentProps>): IDisposable
  get(componentKey: string): ComponentType<IViewComponentProps> | undefined
}

class ViewComponentRegistryImpl implements IViewComponentRegistry {
  private readonly _components = new Map<string, ComponentType<IViewComponentProps>>()

  register(componentKey: string, component: ComponentType<IViewComponentProps>): IDisposable {
    this._components.set(componentKey, component)
    return toDisposable(() => {
      if (this._components.get(componentKey) === component) {
        this._components.delete(componentKey)
      }
    })
  }

  get(componentKey: string): ComponentType<IViewComponentProps> | undefined {
    return this._components.get(componentKey)
  }
}

export const ViewComponentRegistry: IViewComponentRegistry = new ViewComponentRegistryImpl()

/**
 * Optional per-view title-bar toolbar widgets, keyed by view id. Rendered in the
 * view header ahead of the MenuId.ViewTitle action buttons. Populated by
 * `registerViewWithComponent` so a view's toolbar lives with its descriptor
 * instead of in a separate hardcoded map.
 */
class ViewToolbarRegistryImpl {
  private readonly _toolbars = new Map<string, ComponentType>()

  register(viewId: string, toolbar: ComponentType): IDisposable {
    this._toolbars.set(viewId, toolbar)
    return toDisposable(() => {
      if (this._toolbars.get(viewId) === toolbar) this._toolbars.delete(viewId)
    })
  }

  get(viewId: string): ComponentType | undefined {
    return this._toolbars.get(viewId)
  }
}

export const ViewToolbarRegistry = new ViewToolbarRegistryImpl()

/** A view descriptor minus the renderer-only componentKey (derived from `id`). */
export type ViewRegistration = Omit<IViewDescriptor, 'componentKey'>

/**
 * Single-point view registration: declares the descriptor and binds its React
 * component together, deriving a stable componentKey from the view `id`. This
 * removes the cross-file hardcoded-string coupling of the old "three places to
 * edit" flow (descriptor + componentKey + component binding). An optional
 * `toolbar` binds the view's title-bar widget in the same call. Extensions may
 * still use the lower-level `ViewRegistry.registerView` + `ViewComponentRegistry.register`.
 */
export function registerViewWithComponent(
  registration: ViewRegistration,
  component: ComponentType<IViewComponentProps>,
  toolbar?: ComponentType,
): IDisposable {
  return combinedDisposable(
    ViewRegistry.registerView({ ...registration, componentKey: registration.id }),
    ViewComponentRegistry.register(registration.id, component),
    ...(toolbar ? [ViewToolbarRegistry.register(registration.id, toolbar)] : []),
  )
}
